/**
 * 基本面補漲策略型別定義（2026-05-27）
 *
 * 與 lib/valuation/types.ts 區別：
 *   lib/valuation/types.ts — 通用估值積木（RiskFlag / ScenarioResult / DilutionResult 等）
 *   本檔                   — 策略級型別（評分明細、grade、結果列、TW/CN 資料束）
 */

import type {
  RiskFlag,
  ScenarioResult,
  ScenarioKey,
  IndustryTemplate,
  PeRange,
  QuarterRow,
  MonthlyRevenueRow,
  DilutionEvent,
} from '@/lib/valuation/types';

// ────────────────────────────────────────────────────────────────────────────
// 評分明細（100 分制：4 維各 25 分）
// ────────────────────────────────────────────────────────────────────────────

/** 單一加減分項目 */
export interface ScoreItem {
  /** 因子鍵（穩定 ID，contract test 用） */
  key: string;
  /** 加分（正）或扣分（負） */
  delta: number;
  /** 中文敘述（UI 顯示） */
  reason: string;
}

/** 單一維度（25 分）明細 */
export interface DimensionScore {
  /** 該維度名稱（'growth' / 'profitability' / 'valuation' / 'risk'） */
  dimension: 'growth' | 'profitability' | 'valuation' | 'risk';
  /** 中文名（'營收成長' / '獲利改善' / '估值吸引力' / '風險控制'） */
  label: string;
  /** 該維度上限（25） */
  cap: number;
  /** 加減分項目 */
  items: ScoreItem[];
  /** 最終分數（0 ≤ score ≤ cap） */
  score: number;
}

/** 完整評分（4 × 25 = 100） */
export interface ScoreBreakdown {
  growth: DimensionScore;
  profitability: DimensionScore;
  valuation: DimensionScore;
  risk: DimensionScore;
  total: number;
  grade: RecommendationGrade;
  flags: StrategyFlag[];
}

// ────────────────────────────────────────────────────────────────────────────
// 等級與旗標
// ────────────────────────────────────────────────────────────────────────────

export type RecommendationGrade =
  | 'A_core'           // ≥ 85：核心候選
  | 'B_candidate'      // ≥ 75：候選
  | 'C_watch'          // ≥ 65：觀察
  | 'D_weak'           // ≥ 55：弱候選
  | 'excluded';        // < 55：排除

export type StrategyFlag =
  | 'undervalued'                    // 現價低於中性合理價 20% 以上
  | 'high_growth'                    // EPS YoY > 30% 或 月營收 YoY > 30%
  | 'cyclical_peak'                  // 景氣循環高峰（PB 高 + ROE 高 + 產業位階高）
  | 'one_time_gain'                  // 一次性收益佔 EPS 過高
  | 'valuation_stretched'            // 現價已超過中性合理價
  | 'awaiting_financial_validation'  // 需等下一季財報驗證
  | 'only_optimistic_has_upside'     // 只有樂觀情境才有空間（中性無）
  | 'using_pb_evaluation'            // 本業 TTM EPS < 0，切換 PB 評估
  | 'data_conflict'                  // 法說 vs 模型衝突
  | 'dilution_pending';              // 有待生效的增資/CB/GDR

// ────────────────────────────────────────────────────────────────────────────
// TW 資料束（Phase 1 程式端產出，給 skill 用）
// ────────────────────────────────────────────────────────────────────────────

export interface TwFundamentalBundle {
  // 識別
  symbol: string;
  name: string;
  market: 'TW';
  industryCategory: string | null;
  industryTemplate: IndustryTemplate;

  // 行情
  todayPrice: number;
  priceDate: string;

  // 月營收（本地歷史快照 + TWSE/TPEx 官方最新資料）
  monthlyRevenue: MonthlyRevenueRow[];
  latestMonthRevenueYoY: number | null;
  latestMonthRevenueMoM: number | null;
  cumulativeRevenueYoY: number | null;
  last3MonthRevenueYoY: number | null;
  consecutiveGrowthMonths: number;
  isLatest12mHigh: boolean;
  isAllTimeHigh: boolean;

  // 季報（本地歷史快照 + TWSE/TPEx 官方最新資料）
  quarters: QuarterRow[];
  latestQuarterEps: number | null;
  latestQuarterEpsYoY: number | null;
  latestQuarterEpsQoQ: number | null;
  latestGrossMargin: number | null;
  latestNetMargin: number | null;
  latestRoe: number | null;
  ttmEps: number | null;
  ttmPe: number | null;

  // 估值
  bookValuePerShare: number | null;
  pbRatio: number | null;
  sharesOutstanding: number | null;
  peRange: PeRange;

  // 稀釋公告（MOPS）
  dilutionEvents: DilutionEvent[];

  // 風險旗（程式偵測，skill 可補充）
  riskFlags: RiskFlag[];

  // 資料齊全度（0-1）
  dataCompleteness: number;
}

// ────────────────────────────────────────────────────────────────────────────
// CN 資料束
// ────────────────────────────────────────────────────────────────────────────

export interface CnFundamentalBundle {
  symbol: string;
  name: string;
  market: 'CN';
  industryCategory: string | null;
  industryTemplate: IndustryTemplate;

  todayPrice: number;
  priceDate: string;

  // 東財 push2（EastMoneyFundamentals）
  latestQuarterEps: number | null;
  ttmEps: number | null;
  ttmPe: number | null;
  dynamicPe: number | null;
  staticPe: number | null;
  pbRatio: number | null;
  bookValuePerShare: number | null;
  totalShares: number | null;
  floatShares: number | null;
  marketCap: number | null;

  // 季報詳情（EastMoneyFinancialDetail，新增爬蟲）
  latestQuarterRevenue: number | null;
  latestQuarterRevenueYoY: number | null;
  latestQuarterNetProfitParent: number | null;
  latestQuarterNetProfitParentYoY: number | null;
  latestQuarterDeductedNetProfit: number | null;
  latestQuarterDeductedNetProfitYoY: number | null;
  deductedNetProfitRatio: number | null;   // 扣非 / 歸母
  latestGrossMargin: number | null;
  latestNetMargin: number | null;
  roe: number | null;
  operatingCashFlow: number | null;
  inventoryYoY: number | null;
  accountsReceivableYoY: number | null;

  peRange: PeRange;

  riskFlags: RiskFlag[];
  dataCompleteness: number;
}

export type FundamentalBundle = TwFundamentalBundle | CnFundamentalBundle;

// ────────────────────────────────────────────────────────────────────────────
// 程式端結果（Phase 1 輸出）
// ────────────────────────────────────────────────────────────────────────────

export interface FundamentalRevaluationResult {
  symbol: string;
  name: string;
  market: 'TW' | 'CN';
  rank: number;

  // 評分
  breakdown: ScoreBreakdown;

  // 估值快照（程式端三情境，skill 會再補深度）
  scenarios: Record<ScenarioKey, ScenarioResult>;
  ttmEps: number | null;
  ttmPe: number | null;
  todayPrice: number;
  baseFairPrice: number | null;
  baseUpside: number | null;

  // 資料齊全度
  dataCompleteness: number;

  // 主要看多 / 主要風險（程式產出 2-3 條，skill 補敘述）
  bullPoints: string[];
  riskPoints: string[];

  // 後續驗證條件（程式定模板，skill 補具體數字）
  validationConditions: string[];

  // 原始資料束（給 skill 用）
  bundle: FundamentalBundle;

  // 元資料
  computedAt: string;
  strategyVersion: string;
}

/** Phase 1 寫盤格式（一個 market 一個 date 一個檔案） */
export interface FundamentalRevaluationSession {
  market: 'TW' | 'CN';
  date: string;
  strategyVersion: string;
  computedAt: string;
  totalCandidates: number;
  /** 實際完成 pipeline 評估的檔數；不能由截斷後的 Top 100／排除清單反推。 */
  evaluatedCount?: number;
  top100: FundamentalRevaluationResult[];
  exclusionLists: {
    oneTimeGainExcluded: Array<{ symbol: string; name: string; reason: string }>;
    deductedNetProfitPoor: Array<{ symbol: string; name: string; reason: string }>;
    valuationStretched: Array<{ symbol: string; name: string; reason: string }>;
    cyclicalPeak: Array<{ symbol: string; name: string; reason: string }>;
    insufficientData: Array<{ symbol: string; name: string; reason: string }>;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Phase 2 結果（skill 寫的深度分析）
// ────────────────────────────────────────────────────────────────────────────

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface DeepScenarioAssumption {
  scenario: ScenarioKey;
  quarter: 'Q2' | 'Q3' | 'Q4';
  revenueAssumption: number;
  revenueBasis: string;
  netMarginAssumption: number;
  netMarginBasis: string;
  epsResult: number;
  confidenceLevel: ConfidenceLevel;
  validationCondition: string;
  assumptionConflict?: boolean;
}

export interface DeepAnalysis {
  symbol: string;
  scenarios: DeepScenarioAssumption[];
  oneTimeGainDescription: string | null;
  oneTimeGainImpactPctOfEps: number | null;
  cyclicalPeakAssessment: string | null;
  companyGuidanceQuote: string | null;
  companyGuidanceUrl: string | null;
  bullishReasonsZh: string[];
  riskReasonsZh: string[];
  validationConditionsZh: string[];
  dataConflicts: string[];
}

export interface FundamentalRevaluationDeepSession {
  market: 'TW' | 'CN';
  date: string;
  authoredBy: string;          // 'claude-opus-4-7' 等
  analyzedSymbols: string[];
  analyses: DeepAnalysis[];
}

// ────────────────────────────────────────────────────────────────────────────
// 硬條件過濾（Phase 1 第一步）
// ────────────────────────────────────────────────────────────────────────────

export interface HardFilterResult {
  passed: boolean;
  failedReason?: string;
}
