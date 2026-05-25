/**
 * 評分系統型別定義（給 scoring.ts 與 types.ts 共用）
 *
 * 設計原則：
 *   - 評分公式寫在程式裡（lib/agents/scoring.ts），不是 LLM 自評
 *   - LLM 只在 answer 內附 raw signals + 文字推理
 *   - 程式 server-side 在 persistAgentAnswer 時算 scoreBlock 灌進去
 *   - scoringVersion 標記公式版本，未來調權重不破舊資料
 *   - 任一 signal 缺值 → 重新加權其他可用 signal，confidence 降一檔
 */

/** 評分公式版本（改公式 / 改權重必須升 minor）*/
export const SCORING_VERSION = 'v1' as const;
export type ScoringVersion = typeof SCORING_VERSION;

/** 燈號（5 階）*/
export type ScoreLight = 'green' | 'yellow_green' | 'yellow' | 'orange_red' | 'red';

/** 信心程度（看 signal 覆蓋率）*/
export type ScoreConfidence = 'high' | 'medium' | 'low';

/** 4 大面向 ID（與 lib/agents/types.ts AgentId 子集對應）*/
export type ScoredAgentId = 'technical' | 'chip' | 'fundamental' | 'news';

/** A-E 等級 */
export type StockGrade = 'A' | 'B' | 'C' | 'D' | 'E';

/** 適合操作類型 */
export type SuitableFor =
  | 'short_term'    // 短線（1-5 日）
  | 'swing'         // 波段（1-4 週）
  | 'long_term'     // 長線（1 季以上）
  | 'observe_only'  // 只觀察
  | 'avoid';        // 避開

/** 單一 signal 的方向 */
export type SignalDirection = 'bullish' | 'bearish' | 'neutral';

/**
 * 單一 signal 的 raw 值（LLM 在 answer 內填）
 *
 * value === null → 該 signal 缺值（data_missing），程式重新加權
 */
export interface SignalValue {
  /** 原始數值或字串描述（缺值時 null）*/
  value: number | string | null;
  /** 偏多 / 偏空 / 中性（缺值時 'neutral'）*/
  direction: SignalDirection;
  /** 該 signal 對該面向的個別分數 0-100（程式算或 LLM 預估，最終由程式覆蓋）*/
  score: number;
  /** 人話補充（UI tooltip 用）*/
  note?: string;
}

/**
 * 單一 signal 的權重定義（寫在 scoring.ts 的 SIGNAL_SPECS）
 *
 * weight 加總每個 agent 應為 1.0（缺值時動態重新加權）
 */
export interface SignalSpec {
  /** 程式 key（如 'foreignNet5d' / 'monthlyRevenueYoY'）*/
  key: string;
  /** UI 顯示用標籤 */
  label: string;
  /** 0-1 */
  weight: number;
  /** 是否屬「核心 signal」(全部核心都缺才把該 agent 標為 fail)*/
  core?: boolean;
  /** 是否扣分項（觸發時往下扣，不參與正向加權）*/
  penalty?: boolean;
}

/** 資料覆蓋狀態（給 UI 顯示「資料不足」+ confidence 計算）*/
export interface DataStatus {
  /** 有資料的 signal key */
  available: string[];
  /** 缺資料的 signal key */
  missing: string[];
  /** 缺資料時的補充說明（如「FinMind 免費層無 ROE」）*/
  partialReason?: string;
}

/**
 * 每個 analyst 的評分區塊（寫進 answer.scoreBlock）
 *
 * scoreBlock 是 optional 欄位 — 舊 answer 沒有也合法（向下相容）
 */
export interface AgentScoreBlock {
  scoringVersion: ScoringVersion;
  /** 該面向 0-100 分（已按可用 signal 重新加權）*/
  score: number;
  /** 由 scoreToLight 映射 */
  light: ScoreLight;
  /** 由 signal 覆蓋率決定 */
  confidence: ScoreConfidence;
  /**
   * 該 agent 報出的 raw signals
   * key = SignalSpec.key，value = LLM 在 answer 寫的 raw 數據
   */
  signals: Record<string, SignalValue>;
  /** 資料覆蓋狀態 */
  dataStatus: DataStatus;
}

/**
 * 總結 grade 計算的輸入
 */
export interface GradeInput {
  technical: AgentScoreBlock | null;
  chip: AgentScoreBlock | null;
  fundamental: AgentScoreBlock | null;
  news: AgentScoreBlock | null;
  /** Risk Agent verdict（影響 grade 規則 — red 一律 E）*/
  riskVerdict: 'green' | 'yellow' | 'red' | null;
}

/**
 * 總結 grade 計算的輸出（寫進 FinalDecision.gradeBlock）
 */
export interface GradeBlock {
  scoringVersion: ScoringVersion;
  /** 4 面加權後的總分 0-100（缺面向時重新加權）*/
  totalScore: number;
  /** A-E */
  grade: StockGrade;
  /** 為什麼是這級（程式產生的固定模板，不靠 LLM）*/
  gradeReason: string;
  /** 適合操作類型 */
  suitableFor: SuitableFor;
}

/** 個別 agent 權重（在總分計算用）*/
export const AGENT_WEIGHTS: Record<ScoredAgentId, number> = {
  technical: 0.30,
  chip: 0.25,
  fundamental: 0.25,
  news: 0.20,
};
