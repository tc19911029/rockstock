// ============================================================
// 賣出訊號「輕重」回測 — 型別契約（單一事實來源）
//
// 把每個賣出/出場訊號當「離散事件」，逐根回放全市場歷史，量「訊號日收盤後
// d1/d3/d5/d10/d20 的報酬 + 窗內最大回落」，並扣掉「同日同儕宇宙平均」(alpha) 控制行情，
// 排出「最重 → 最輕」。純測量，不改任何生產選股/賣出邏輯。
//
// 形狀刻意對齊 lib/backtest/leaderboardTypes.ts 的 LeaderboardDoc，方便日後接前端。
// ============================================================

import type { Market } from './leaderboardTypes';
export type { Market };

/** 量測情境：all = 不設限；uptrend = 訊號當下仍在多頭持股情境（close>ma20 且 ma5>ma20 且前月漲≥門檻）。 */
export type SellScope = 'all' | 'uptrend';
export const SELL_SCOPES: SellScope[] = ['all', 'uptrend'];

/** 訊號家族：book = 朱書 detectSellSignals 21 種；sanse = 三色該賣；combo = 衍生組合。 */
export type SignalFamily = 'book' | 'sanse' | 'combo';

/** forward horizon（訊號日收盤計價）。 */
export type SellHorizon = 'd1' | 'd3' | 'd5' | 'd10' | 'd20';
export const SELL_HORIZONS: SellHorizon[] = ['d1', 'd3', 'd5', 'd10', 'd20'];

export type DeclaredSeverity = 'high' | 'medium' | 'low' | null;

/** 手寫嚴重度 vs 實測輕重的對照判決。 */
export type SeverityVerdict = 'agree' | 'overrated' | 'underrated' | 'n/a';

/** 某 horizon 下的統計（含同儕基準與 alpha）。 */
export interface SellHorizonStat {
  n: number;             // 有效樣本數（該 horizon 非 null 的 firing 數）
  avgRetPct: number;     // 訊號平均報酬 %（收盤基準）
  medianRetPct: number;
  cohortAvgPct: number;  // 同日同儕宇宙平均報酬 %（同情境）
  alphaPct: number;      // avgRet − cohort（越負越重）
  alphaShrunkPct: number;// (n·alpha)/(n+K)，prior=0（無樣本=無 edge）
  downRatePct: number;   // 該 horizon 收盤 < base 的比例 %
}

/** 一個訊號（在某市場、某情境）的完整輕重統計。 */
export interface SignalStat {
  signalType: string;            // 'DEATH_CROSS' | 'b_dead' | 'combo:DEATH_CROSS+BREAK_MA20' …
  label: string;                 // 繁中標籤
  family: SignalFamily;
  market: Market;
  scope: SellScope;
  declaredSeverity: DeclaredSeverity;  // 手寫嚴重度（受測；sanse/combo 為 null）
  firings: number;               // 觸發事件數（已扣 suspect）
  byHorizon: Record<SellHorizon, SellHorizonStat>;

  avgMaxDrawdownPct: number;     // 平均窗內最大回落（越負越重）
  avgMaxGainPct: number;
  avgGapReturnPct: number;       // 平均隔夜跳空
  downHit3Pct: number;           // 5 日內盤中跌 ≥3% 比例
  downHit5Pct: number;           // 5 日內盤中跌 ≥5% 比例
  downHit3ExcessPct: number;     // 減同儕同情境基準
  downHit5ExcessPct: number;

  // headline（d5）
  alphaD5: number;
  alphaD5Shrunk: number;
  /** d5/d10/d20 收斂 alpha 中最負的一個（慢發訊號的真實輕重；嚴重度判決用此）。 */
  worstFwdAlphaShrunk: number;
  heavinessScore: number;        // 次要複合分（權重透明、放 sellHeaviness.ts 檔頭 config）

  tStat: number;                 // alphaD5mean / (std/√n)，啟發式（firing 非 iid）
  significant: boolean;          // |t| > 2
  stable: boolean;               // 半窗 early/late alphaD5 同號且倍率 < 2×
  alphaD5EarlyHalf: number;
  alphaD5LateHalf: number;

  volSuspectShare: number;       // firing 中被標 volSuspect 的比例（量門控訊號才有意義）
  underpowered: boolean;         // firings < MIN_FIRINGS
  severityVerdict: SeverityVerdict;  // 手寫 vs 實測

  sampleFirings: SellSampleFiring[]; // 最近 N 筆（newest first，供抽查）
}

export interface SellSampleFiring {
  date: string;
  symbol: string;
  name: string;
  base: number;        // 訊號日收盤
  d5: number | null;
  maxDrawdown: number | null;
  inContext: boolean;
}

export interface SellHeavinessDoc {
  generatedAt: string;            // ISO（前端顯示 +8h 轉 CST）
  entryBaseline: 'signal-close';  // 量測基準恆為訊號日收盤
  window: {
    start: string;
    end: string;
    tradingDays: number;
    label: string;
    forwardTd: number;
  };
  horizons: SellHorizon[];
  signals: SignalStat[];          // 扁平；前端可按 market/scope/family 過濾
  /** P(B 同根觸發 | A 觸發)，每市場一張，揭露多重共線性。 */
  coOccurrence: Record<Market, Record<string, Record<string, number>>>;
  meta: {
    survivorshipNote: string;     // 方向與買方相反：下市最慘案例缺席 → 賣訊輕重「低估」
    minFirings: number;
    shrinkK: number;
    cohortMinN: number;
    holdableContext: { upThr: number; lookbackN: number };
    heavinessWeights: { w1: number; w2: number; w3: number };
    notes: string[];
  };
}
