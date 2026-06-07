/**
 * 籌碼面「成本／壓力價」總覽型別（9 項指標）
 *
 * 全部成本皆為「估算」：cost = Σ(每日新增張數 × 當日VWAP) / Σ新增張數。
 * 共用 lib/squeeze/costEstimator.ts 的 weightedCost()。
 *
 * 9 項：外資/投信/自營/主力/融資/融券/券賣 成本 + 嘎空價 + 融資斷頭價。
 */

/** 5/10/20/60 日加權平均成本（null = 該窗口無新建立部位/無資料） */
export interface CostBucket {
  d5: number | null;
  d10: number | null;
  d20: number | null;
  d60: number | null;
}

/** 融資斷頭壓力分數（0–100，5 個 20 分子項；多方/下跌方向） */
export interface MarginLiquidationScore {
  marginAccumulation: number;    // 0-20 融資餘額累積（散戶加槓桿）
  utilizationHigh: number;       // 0-20 融資使用率偏高
  belowMarginCost: number;       // 0-20 跌破融資成本（套牢）
  liquidationPressure: number;   // 0-20 距斷頭價遠近
  breakdownVolume: number;       // 0-20 量價走弱/破前低
  total: number;                 // 0-100
  level: 'low' | 'mild' | 'potential' | 'high' | 'extreme';
  levelLabel: string;            // 中文
}

/** 主力成本成熟度（分點歷史）：歷史不足時誠實標示 */
export type BrokerCostStatus = 'ok' | 'accumulating' | 'unavailable';

/** 主力成本的計算口徑：
 *  - branch    = Yahoo 分點 top-15 累積 ≥20 日（較純）
 *  - composite = 法人+融資+借券 合成估算（分點歷史不足時的 fallback，可立即回推）
 *  - none      = 兩者皆無 */
export type BrokerCostMethod = 'branch' | 'composite' | 'none';

/** 7 路加權平均成本（估算） */
export interface CostBuckets {
  foreign: CostBucket;   // #1 外資
  trust: CostBucket;     // #2 投信
  dealer: CostBucket;    // #3 自營商
  broker: CostBucket;    // #4 主力（分點 top-15 聚合 proxy）
  margin: CostBucket;    // #5 融資（多方）
  short: CostBucket;     // #6 融券
  sbl: CostBucket;       // #7 券賣（借券賣出）
}

/** 各路 d20 成本 vs 現價 %（正=現價在成本之上） */
export interface VsClosePct {
  foreign: number | null;
  trust: number | null;
  dealer: number | null;
  broker: number | null;
  margin: number | null;
  short: number | null;
  sbl: number | null;
}

/** /api/cost-basis 完整回傳 */
export interface CostBasisBundle {
  symbol: string;
  name: string;
  asOfDate: string;
  close: number;

  costs: CostBuckets;
  vsClosePct: VsClosePct;

  // 關鍵壓力價
  squeezePrice: number | null;             // #8 嘎空價（融券追繳壓力價，價漲觸發）
  marginLiquidationPrice: number | null;   // #9 融資斷頭價（130%，價跌觸發）
  marginCallPrice140: number | null;       // 融資追繳警戒價（140%）
  distanceToLiquidationPct: number | null; // 現價距斷頭價 %（正=現價在斷頭價之上、有緩衝）

  // 融資斷頭壓力分數 + 白話解讀 + 風險提示
  marginScore: MarginLiquidationScore;
  interpretation: string;
  warnings: string[];

  // metadata
  marginRatio: number;                     // 融資成數（0.6 上市 / 0.5 上櫃）
  brokerStatus: BrokerCostStatus;          // 主力分點歷史成熟度
  brokerCostMethod: BrokerCostMethod;      // 主力成本實際採用的口徑
  dataCompleteness: {
    instDays: number;
    marginDays: number;
    brokerDays: number;
    priceDays: number;
  };
}

/** /api/chip 內嵌的精簡摘要（首頁籌碼 tab 用） */
export interface CostBasisSummary {
  // 7 路成本各取 d20
  foreignCost: number | null;
  trustCost: number | null;
  dealerCost: number | null;
  brokerCost: number | null;
  marginCost: number | null;
  shortCost: number | null;
  sblCost: number | null;
  // 兩個關鍵價位
  squeezePrice: number | null;
  marginLiquidationPrice: number | null;
  distanceToLiquidationPct: number | null;
  brokerStatus: BrokerCostStatus;
  brokerCostMethod: BrokerCostMethod;
}

export const EMPTY_BUCKET: CostBucket = { d5: null, d10: null, d20: null, d60: null };
