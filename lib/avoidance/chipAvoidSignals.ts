/**
 * 籌碼型避雷訊號 — 買進前的「別踩雷」檢查（純函式，2026-06-14）
 *
 * 來源：scripts/factor-grid-search.ts（234 組合 train/test）兩年都站得住的避雷訊號。
 * 與 lib/avoidance/antiSignals.ts（統計反指標）同性質，但這幾個是「個股當下可算」的籌碼型：
 *   ① 大戶持股水位超高 — 流通量太少/大戶已吃完 → 系統性偏弱（門檻=各級距 90 百分位）
 *   ② 假集中度 — 主力分點集中度看似高，但法人同步在賣（多半隔日沖假象）
 *   ③ 爆量長黑破月線且法人沒接 — 真破線（注意：爆量長黑+法人接=反彈，差在法人站哪邊）
 *
 * ⚠️ 只示警、不剔除（呼應 [[redflags_pre_buy_check]] 慣例）。價量型危險訊號單獨不可當避雷
 *   （[[avoidance_layer_price_signals_reverse]]）— 故 ③ 一定要綁「法人沒接」才成立。
 * 門檻凍結；改動請先重跑 factor-grid-search.ts 複驗。
 */

export interface AvoidCandle { date: string; open: number; high: number; low: number; close: number; volume: number }

export interface ChipAvoidInput {
  price: number;
  candles: AvoidCandle[]; // 升冪日K
  holderRows: Array<{ date: string; holder100Pct?: number; holder400Pct?: number; holder1000Pct?: number }>; // 升冪集保
  brokerByDate: Map<string, number>; // 主力分點淨買賣超(張)
  instByDate: Map<string, number>;   // 三大法人合計買賣超(張)
}

export interface AvoidFlag {
  key: 'holder_too_high' | 'fake_concentration' | 'volume_black_breakdown';
  label: string;
  detail: string;
}

/** 凍結門檻（factor-grid-search.ts 90 百分位 / refined 條件） */
export const CHIP_AVOID_PARAMS = {
  /** 大戶持股「超高」門檻（依股價挑級距）*/
  holderHighPct: { h100: 88, h400: 86, h1000: 80 },
  /** 假集中度：主力分點 5 日集中度 > 此值 且 法人在賣 */
  shortWin: 5,
  longWin: 20,
  fakeConcMin: 3,
  /** 爆量長黑：今日 收/開-1 < 此值 */
  blackKpct: -3,
  /** 量比 > 此值算爆量 */
  volSpikeX: 2,
} as const;

function sumOver(map: Map<string, number>, candles: AvoidCandle[], from: number, to: number): number | null {
  let s = 0;
  for (let k = from; k <= to; k++) {
    if (!map.has(candles[k].date)) return null;
    s += map.get(candles[k].date)!;
  }
  return s;
}

/** 算出個股當下的籌碼避雷紅旗（買進前看一眼，只示警） */
export function computeChipAvoidSignals(input: ChipAvoidInput): { flags: AvoidFlag[]; hasAvoid: boolean } {
  const { price, candles, holderRows, brokerByDate, instByDate } = input;
  const P = CHIP_AVOID_PARAMS;
  const flags: AvoidFlag[] = [];
  const n = candles.length;
  if (n < P.longWin + 1) return { flags, hasAvoid: false };
  const t = n - 1;

  // ① 大戶持股水位超高（依股價挑級距）
  const latestHolder = [...holderRows].reverse().find(r =>
    r && (r.holder100Pct != null || r.holder400Pct != null || r.holder1000Pct != null));
  if (latestHolder) {
    const tier = price >= 250 ? { v: latestHolder.holder100Pct, th: P.holderHighPct.h100, name: '百張大戶' }
      : price >= 50 ? { v: latestHolder.holder400Pct, th: P.holderHighPct.h400, name: '400張大戶' }
        : { v: latestHolder.holder1000Pct, th: P.holderHighPct.h1000, name: '千張大戶' };
    if (tier.v != null && tier.v > tier.th) {
      flags.push({
        key: 'holder_too_high',
        label: '大戶持股超高',
        detail: `${tier.name}持股 ${tier.v.toFixed(1)}%（>${tier.th}%）— 流通量太少、大戶多半已吃完，之後系統性偏弱`,
      });
    }
  }

  // ② 假集中度：主力分點 5 日集中度 > 3% 但法人 5 日在賣
  let vol5 = 0; for (let k = t - P.shortWin + 1; k <= t; k++) vol5 += candles[k].volume || 0;
  const brk5 = sumOver(brokerByDate, candles, t - P.shortWin + 1, t);
  const inst5 = sumOver(instByDate, candles, t - P.shortWin + 1, t);
  const conc5 = brk5 != null && vol5 > 0 ? (brk5 / vol5) * 100 : null;
  if (conc5 != null && conc5 > P.fakeConcMin && inst5 != null && inst5 < 0) {
    flags.push({
      key: 'fake_concentration',
      label: '假集中度',
      detail: `主力分點5日集中度 ${conc5.toFixed(1)}% 看似高，但法人5日淨賣 ${Math.round(inst5).toLocaleString()} 張 — 多半是隔日沖假象`,
    });
  }

  // ③ 爆量長黑 + 跌破月線 + 法人沒接
  const last = candles[t];
  const todayChg = last.open > 0 ? (last.close / last.open - 1) * 100 : 0;
  let v20 = 0; for (let k = t - P.longWin + 1; k <= t; k++) v20 += candles[k].volume || 0;
  const avgVol = v20 / P.longWin;
  let ma20 = 0; for (let k = t - P.longWin + 1; k <= t; k++) ma20 += candles[k].close; ma20 /= P.longWin;
  const volSpike = avgVol > 0 && last.volume > P.volSpikeX * avgVol;
  if (todayChg < P.blackKpct && volSpike && last.close < ma20 && inst5 != null && inst5 <= 0) {
    flags.push({
      key: 'volume_black_breakdown',
      label: '爆量長黑破月線',
      detail: `今日長黑 ${todayChg.toFixed(1)}% + 爆量(${(last.volume / avgVol).toFixed(1)}倍) + 跌破月線，且法人沒接 — 真破線、之後更弱`,
    });
  }

  return { flags, hasAvoid: flags.length > 0 };
}
