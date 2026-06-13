/**
 * 操作分類器（P3，純函式）— 把候選股分成陸股短線 10 種打法
 *
 * 打板 / 半路 / 低吸 / 反包 / 弱轉強 / 趨勢 / 波段 / 補漲 / 防守 / 高風險情緒股
 *
 * 全用日K代理（無分時資料）：弱轉強需要次日競價確認 → 輸出 conditional
 * 「明日競價高開>2% 觸發」，盤後無法定論。情緒階段（cycleStage）當前置門檻：
 * 殺跌/冰點期 primary 一律 observe（不論個股多漂亮，逆風不打）。
 *
 * 參數集中 TACTIC_PARAMS（仿 cycle.ts PHASE_PARAMS）。輸入 TechFeatures 全 optional
 * （除 boards/isLimitUpToday）—— compose 餵得到什麼算什麼，缺均線特徵的分支自動不觸發。
 */

import type { EmotionStage, StockPosition } from './types';
import type { BaselineCandle } from '@/lib/backtest/eventBaseline';

export type Tactic =
  | 'daban'       // 打板
  | 'banlu'       // 半路
  | 'dixi'        // 低吸
  | 'fanbao'      // 反包
  | 'weakToStrong'// 弱轉強
  | 'trend'       // 趨勢
  | 'swing'       // 波段
  | 'buchang'     // 補漲
  | 'defensive'   // 防守
  | 'highRisk'    // 高風險情緒股
  | 'observe';    // 觀望

export const TACTIC_LABELS_FULL: Record<Tactic, string> = {
  daban: '打板', banlu: '半路', dixi: '低吸', fanbao: '反包', weakToStrong: '弱轉強',
  trend: '趨勢', swing: '波段', buchang: '補漲', defensive: '防守', highRisk: '高風險情緒股',
  observe: '觀望',
};

export const TACTIC_PARAMS = {
  highRisk: { boardsMin: 5, gain20dMax: 50 },
  daban:    { boardsMax: 3 },
  banlu:    { pctMin: 5, pctMax: 9.7, volRatioMin: 2 },
  dixi:     { maDevMax: 2, volRatioMax: 0.8 },
  fanbao:   { volRatioMin: 1.2 },
  trend:    { gain20dMin: 20, gain20dMax: 40 },
  buchang:  { ownBoardsMax: 1, gain20dMax: 15 },
} as const;

export interface TechFeatures {
  /** 連板數（首板=1，非漲停=0） */
  boards: number;
  isLimitUpToday: boolean;
  isOneWord?: boolean;
  todayPct?: number | null;
  /** 昨日是否炸板 */
  yesterdayBroken?: boolean;
  /** 昨日是否跌停/大陰（< -5%） */
  yesterdayWeak?: boolean;
  cycleStage: EmotionStage;
  /** skill 給的題材地位 */
  themePosition?: StockPosition | null;
  /** 所屬題材龍頭連板數（補漲判定） */
  themeLeaderBoards?: number | null;
  // ── 日K 衍生特徵（computeTechFeatures，缺則該分支不觸發） ──
  gain20d?: number | null;        // 近 20 日漲幅 %
  pctAboveMa5?: number | null;    // 收盤距 MA5 乖離 %
  pctAboveMa10?: number | null;
  pctAboveMa20?: number | null;
  maBullish?: boolean | null;     // MA5>MA10>MA20 且上揚
  isNew20dHigh?: boolean | null;
  volRatio5d?: number | null;     // 今量 / 5 日均量
  recoveredYestBody?: boolean | null; // 今紅K 收復昨實體 1/2 以上
  closedNearLow?: boolean | null; // 收最低 1/3（防守訊號）
}

export interface TacticResult {
  primary: Tactic;
  eligible: Tactic[];
  conditional: { tactic: Tactic; trigger: string } | null;
  riskTag: string | null;
  reasons: string[];
}

const isWeakStage = (s: EmotionStage) => s === 'crash' || s === 'frozen';
const isToppy = (s: EmotionStage) => s === 'climax' || s === 'divergence' || s === 'retreat';

/** 升冪 K 線 → 最後一根的技術特徵（不足則對應欄 null）。 */
export function computeTechFeatures(candles: BaselineCandle[] | null): Partial<TechFeatures> {
  if (!candles || candles.length < 2) return {};
  const n = candles.length;
  const last = candles[n - 1];
  const ma = (len: number): number | null => {
    if (n < len) return null;
    let s = 0;
    for (let i = n - len; i < n; i++) s += candles[i].close;
    return s / len;
  };
  const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20);
  const dev = (m: number | null): number | null => (m && m > 0 ? +((last.close - m) / m * 100).toFixed(2) : null);
  const gain20d = n >= 21 && candles[n - 21].close > 0
    ? +((last.close - candles[n - 21].close) / candles[n - 21].close * 100).toFixed(2) : null;
  const vol5 = n >= 6 ? candles.slice(n - 6, n - 1).reduce((a, c) => a + c.volume, 0) / 5 : null;
  const volRatio5d = vol5 && vol5 > 0 ? +(last.volume / vol5).toFixed(2) : null;
  const isNew20dHigh = n >= 21 ? last.high >= Math.max(...candles.slice(n - 21, n - 1).map((c) => c.high)) : null;
  // MA 多頭：5>10>20 且 ma5 較前一日上揚
  const ma5Prev = n >= 6 ? candles.slice(n - 6, n - 1).reduce((a, c) => a + c.close, 0) / 5 : null;
  const maBullish = ma5 != null && ma10 != null && ma20 != null && ma5Prev != null
    ? ma5 > ma10 && ma10 > ma20 && ma5 > ma5Prev : null;
  const prev = candles[n - 2];
  // 反包：今紅K 收復昨實體 1/2（昨為陰線 prev.close<prev.open）
  const recoveredYestBody = prev.close < prev.open
    ? last.close >= (prev.open + prev.close) / 2 && last.close > last.open : false;
  const closedNearLow = last.high > last.low
    ? (last.close - last.low) / (last.high - last.low) < 0.34 : false;
  return {
    gain20d, pctAboveMa5: dev(ma5), pctAboveMa10: dev(ma10), pctAboveMa20: dev(ma20),
    maBullish, isNew20dHigh, volRatio5d, recoveredYestBody, closedNearLow,
  };
}

export function classifyTactic(f: TechFeatures): TacticResult {
  const P = TACTIC_PARAMS;
  const reasons: string[] = [];
  const eligible: Tactic[] = [];
  let conditional: TacticResult['conditional'] = null;
  let riskTag: string | null = null;

  const g20 = f.gain20d ?? null;
  const vr = f.volRatio5d ?? null;

  // 高風險情緒股（標 riskTag，不阻止其他判定）
  if ((f.boards >= P.highRisk.boardsMin || (g20 != null && g20 > P.highRisk.gain20dMax)) && isToppy(f.cycleStage)) {
    riskTag = `高位情緒股（${f.boards}板${g20 != null ? `、20日+${g20}%` : ''}、${f.cycleStage} 期）追高風險大`;
  }

  // 殺跌/冰點：一律觀望（逆風不打），但仍標 eligible 供參考
  const weakStage = isWeakStage(f.cycleStage);

  // 各打法判定（蒐集 eligible，primary 取優先序最高）
  // 打板
  if (f.isLimitUpToday && !f.isOneWord && f.boards >= 1 && f.boards <= P.daban.boardsMax
      && (f.themePosition === 'leader' || f.themePosition === 'core' || f.themePosition == null)) {
    eligible.push('daban');
    reasons.push(`${f.boards}板換手漲停${f.themePosition ? `、題材${f.themePosition}` : ''}`);
  }
  // 一字板 → 買不到，歸觀望
  if (f.isLimitUpToday && f.isOneWord) {
    eligible.push('observe');
    reasons.push('一字板買不進');
  }
  // 反包
  if (f.recoveredYestBody && (vr == null || vr > P.fanbao.volRatioMin) && (f.todayPct ?? 0) > 0) {
    eligible.push('fanbao');
    reasons.push('紅K收復昨陰實體過半（反包）');
  }
  // 弱轉強（conditional，需次日競價確認）
  if ((f.yesterdayBroken || f.yesterdayWeak) && (f.todayPct ?? 0) >= 0) {
    conditional = { tactic: 'weakToStrong', trigger: '明日競價高開 >2% 觸發' };
    reasons.push('昨弱今穩，待明日競價弱轉強');
  }
  // 半路
  if (!f.isLimitUpToday && (f.todayPct ?? 0) >= P.banlu.pctMin && (f.todayPct ?? 0) < P.banlu.pctMax
      && (vr == null || vr > P.banlu.volRatioMin)) {
    eligible.push('banlu');
    reasons.push(`漲${f.todayPct}%未封、放量（半路）`);
  }
  // 低吸
  if (f.boards === 0 && f.pctAboveMa5 != null && Math.abs(f.pctAboveMa5) < P.dixi.maDevMax
      && vr != null && vr < P.dixi.volRatioMax) {
    eligible.push('dixi');
    reasons.push('回踩MA5縮量（低吸）');
  }
  // 補漲
  if (f.themeLeaderBoards != null && f.themeLeaderBoards >= 3 && f.boards <= P.buchang.ownBoardsMax
      && g20 != null && g20 < P.buchang.gain20dMax) {
    eligible.push('buchang');
    reasons.push(`題材龍頭${f.themeLeaderBoards}板、本股低位（補漲）`);
  }
  // 趨勢
  if (f.isNew20dHigh && f.maBullish && g20 != null && g20 >= P.trend.gain20dMin && g20 <= P.trend.gain20dMax) {
    eligible.push('trend');
    reasons.push('20日新高+均線多頭（趨勢）');
  }
  // 波段
  if (f.maBullish && f.pctAboveMa20 != null && f.pctAboveMa20 > 0 && f.boards === 0 && (vr == null || vr > 1)) {
    eligible.push('swing');
    reasons.push('站上MA20+均線多頭（波段）');
  }
  // 防守
  if (f.closedNearLow && f.pctAboveMa5 != null && f.pctAboveMa5 < 0) {
    eligible.push('defensive');
    reasons.push('跌破MA5收最低1/3（防守）');
  }

  // primary 決策：弱勢階段觀望；否則按優先序
  const order: Tactic[] = ['daban', 'banlu', 'fanbao', 'dixi', 'buchang', 'trend', 'swing', 'defensive', 'observe'];
  let primary: Tactic;
  if (weakStage) {
    primary = 'observe';
    reasons.unshift(`${f.cycleStage} 逆風期，primary 觀望`);
  } else {
    primary = order.find((t) => eligible.includes(t)) ?? 'observe';
  }

  return { primary, eligible: [...new Set(eligible)], conditional, riskTag, reasons: reasons.slice(0, 6) };
}
