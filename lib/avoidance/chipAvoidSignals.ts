/**
 * 籌碼型避雷訊號 — 買進前的「別踩雷」檢查（純函式，2026-06-14）
 *
 * 來源：scripts/factor-grid-search.ts（234 組合 train/test）兩年都站得住的避雷訊號。
 * 與 lib/avoidance/antiSignals.ts（統計反指標）同性質，但這幾個是「個股當下可算」的籌碼型：
 *   ① 大戶持股水位超高 — 流通量太少/大戶已吃完 → 系統性偏弱（門檻=各級距 90 百分位）
 *   ② 假集中度 — 主力分點集中度看似高，但法人同步在賣（多半隔日沖假象）
 *   ③ 爆量長黑破月線且法人沒接 — 真破線（注意：爆量長黑+法人接=反彈，差在法人站哪邊）
 *   ④ 高檔法人連賣 — 課程淘汰法13（R8 復活，2026-07-05 backtest-inst-sell-avoid：
 *      六個 train/test 段全同方向更弱，test D20 −1.9pp、事後跌率 59% vs 對照 52%）
 *   ⑤ 法人連賣（書本淘汰法 R8 原文版，無高檔限定）— 2026-07-05
 *      backtest-r8-inst-sell-streak：15 萬觀測去 beta，連賣天數與後續超額單調負相關、
 *      train/test 一致（≥3 天 D20 −0.53/−0.79%；≥5 天最毒 −0.87/−2.50%、勝率 30%）。
 *      ④ 命中時不重複報 ⑤（高檔版較嚴重、訊息不疊）。
 *
 * ⚠️ 只示警、不剔除（呼應 [[redflags_pre_buy_check]] 慣例）。價量型危險訊號單獨不可當避雷
 *   （[[avoidance_layer_price_signals_reverse]]）— 故 ③ 一定要綁「法人沒接」才成立。
 * ⚠️ R8 刻意不進掃描鏈硬排除（applyPanelFilter/淘汰法）：inst 資料是本機 lazy-fetch
 *   （ChipStorage 無 Blob 雙存儲、覆蓋非全市場），Vercel 掃描 cron 讀不到 →
 *   進淘汰法會讓本機/雲端掃描結果分歧（破壞 scan-parity）。要升級硬排除，先把 inst
 *   改全市場每日 cron + dual-storage。
 * 門檻凍結；改動請先重跑 factor-grid-search.ts / backtest-r8-inst-sell-streak.ts 複驗。
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
  key: 'holder_too_high' | 'fake_concentration' | 'volume_black_breakdown' | 'inst_sell_streak_high' | 'inst_sell_streak';
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
  /** ④⑤ 法人連賣天數門檻（書本 R8：連續賣超；回測 ≥3 兩段皆負） */
  instSellStreakMin: 3,
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

  // ④⑤ 法人連賣（書本淘汰法 R8）：三大法人合計連續賣超 ≥3 天
  //    ④ 高檔版（較嚴重）：另需 收盤在近60根最高收盤 90% 以上 且 近60根漲幅 ≥20%（與回測同口徑）
  //    ⑤ 原文版（無高檔限定，backtest-r8-inst-sell-streak 驗證）：④ 命中時不重複報
  {
    let streak = 0;
    for (let k = t; k >= Math.max(0, t - 19); k--) {
      const v = instByDate.get(candles[k].date);
      if (v == null || v >= 0) break;
      streak++;
    }
    if (streak >= P.instSellStreakMin) {
      let isHighPosition = false;
      if (n >= 61) {
        let hi60 = 0;
        for (let k = t - 60; k <= t; k++) hi60 = Math.max(hi60, candles[k].close);
        const gain60 = candles[t - 60].close > 0 ? candles[t].close / candles[t - 60].close - 1 : 0;
        isHighPosition = candles[t].close >= hi60 * 0.90 && gain60 >= 0.20;
      }
      if (isHighPosition) {
        flags.push({
          key: 'inst_sell_streak_high',
          label: '高檔法人連賣',
          detail: `法人已連續賣超 ${streak} 天且股價在高檔 — 課程淘汰法：別碰（回測：這種股之後 10 次有 6 次輸大盤）`,
        });
      } else {
        flags.push({
          key: 'inst_sell_streak',
          label: '法人連賣',
          detail: `三大法人已連續賣超 ${streak} 天（書本淘汰法 R8）— 回測：連賣越久之後越弱、≥5 天最明顯，等買盤回來再看`,
        });
      }
    }
  }

  return { flags, hasAvoid: flags.length > 0 };
}
