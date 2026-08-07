import type {
  QuarterRow,
  ScenarioAssumption,
  ScenarioResult,
  PeRange,
  ScenarioKey,
} from './types';

/**
 * 計算單一情境的全年 EPS + Forward PE + 合理價 + 上漲空間。
 *
 * 假設輸入：
 *   - quarters[0] 是最新已公布季（例：Q1）
 *   - assumption 包含 Q2/Q3/Q4 預估營收與淨利率
 *   - partialQuarterRevenue 是當季已過部分（例：4 月營收）— 會與 Q2 假設加總
 *   - shares 是流通股數
 *   - fairPe 是該情境合理本益比
 */
export function computeScenario(
  quarters: QuarterRow[],
  assumption: ScenarioAssumption,
  shares: number,
  fairPe: number,
  currentPrice: number
): ScenarioResult {
  if (!shares || shares <= 0) {
    return {
      q2Eps: 0,
      q3Eps: 0,
      q4Eps: 0,
      fullYearEps: 0,
      forwardPe: Number.POSITIVE_INFINITY,
      fairPe,
      fairPrice: 0,
      upside: 0,
    };
  }

  const parsed = quarters
    .map((row) => ({ row, parsed: parseQuarter(row.quarter) }))
    .filter((item): item is { row: QuarterRow; parsed: { year: number; quarter: number } } => item.parsed != null)
    .sort((a, b) => b.parsed.year - a.parsed.year || b.parsed.quarter - a.parsed.quarter);
  const fiscalYear = parsed[0]?.parsed.year;
  const actualByQuarter = new Map<number, QuarterRow>();
  for (const item of parsed) {
    if (item.parsed.year !== fiscalYear || actualByQuarter.has(item.parsed.quarter)) continue;
    if (Number.isFinite(item.row.eps)) actualByQuarter.set(item.parsed.quarter, item.row);
  }

  const latestActualQuarter = Math.max(0, ...actualByQuarter.keys());
  const partialQuarter = Math.min(4, latestActualQuarter + 1);
  const estimate = (quarter: 2 | 3 | 4): number => {
    const actual = actualByQuarter.get(quarter);
    if (actual) return actual.eps;
    const revenue = assumption[`q${quarter}Revenue`] ?? 0;
    const margin = assumption[`q${quarter}NetMargin`] ?? 0;
    const partial = quarter === partialQuarter ? assumption.partialQuarterRevenue ?? 0 : 0;
    return ((revenue + partial) * margin) / shares;
  };

  const q1Eps = actualByQuarter.get(1)?.eps ?? 0;
  const q2Eps = estimate(2);
  const q3Eps = estimate(3);
  const q4Eps = estimate(4);
  const fullYearEps = q1Eps + q2Eps + q3Eps + q4Eps;
  const forwardPe = fullYearEps > 0 ? currentPrice / fullYearEps : Number.POSITIVE_INFINITY;
  const fairPrice = fullYearEps * fairPe;
  const upside = currentPrice > 0 ? fairPrice / currentPrice - 1 : 0;

  return {
    q2Eps,
    q3Eps,
    q4Eps,
    fullYearEps,
    forwardPe,
    fairPe,
    fairPrice,
    upside,
  };
}

function parseQuarter(value: string): { year: number; quarter: number } | null {
  const label = value.match(/^(\d{4})Q([1-4])$/i);
  if (label) return { year: Number(label[1]), quarter: Number(label[2]) };
  const date = value.match(/^(\d{4})-(\d{2})/);
  if (!date) return null;
  const month = Number(date[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(date[1]), quarter: Math.ceil(month / 3) };
}

/**
 * 一次算三情境。
 */
export function computeAllScenarios(
  quarters: QuarterRow[],
  assumptions: Record<ScenarioKey, ScenarioAssumption>,
  shares: number,
  peRange: PeRange,
  currentPrice: number
): Record<ScenarioKey, ScenarioResult> {
  return {
    pessimistic: computeScenario(quarters, assumptions.pessimistic, shares, peRange.pessimistic, currentPrice),
    base: computeScenario(quarters, assumptions.base, shares, peRange.base, currentPrice),
    optimistic: computeScenario(quarters, assumptions.optimistic, shares, peRange.optimistic, currentPrice),
  };
}

/**
 * 由 Forward PE vs 合理 PE 推結論。
 */
export function deriveConclusion(
  baseScenario: ScenarioResult
): 'undervalued' | 'fair' | 'overvalued' {
  const ratio = baseScenario.forwardPe / baseScenario.fairPe;
  if (ratio < 0.8) return 'undervalued';
  if (ratio > 1.2) return 'overvalued';
  return 'fair';
}

// ────────────────────────────────────────────────────────────────────────────
// 反推 H2 所需營收（給定目標全年 EPS）
// ────────────────────────────────────────────────────────────────────────────

export interface ReverseEngineerInput {
  targetFullYearEps: number;
  q1Eps: number;
  q2Eps: number;
  shares: number;
  h2NetMargin: number;
}

export interface ReverseEngineerOutput {
  h2RequiredEps: number;
  h2RequiredNetIncome: number;
  h2RequiredRevenue: number;
  /** Q3:Q4 = 47:53 預設分配（下半年放量曲線） */
  q3SuggestedRevenue: number;
  q4SuggestedRevenue: number;
  q3MonthlyAvg: number;
  q4MonthlyAvg: number;
}

/**
 * 給定目標全年 EPS → 反推 H2 (Q3+Q4) 所需營收，並建議 Q3/Q4 分配。
 *
 * 公式：
 *   H2 所需 EPS = 目標全年 EPS - Q1 EPS - Q2 EPS
 *   H2 所需稅後淨利 = H2 所需 EPS × 股數
 *   H2 所需營收 = H2 所需稅後淨利 / H2 淨利率
 *   預設 Q3:Q4 = 47:53（多數成長股下半年放量曲線）
 */
export function reverseEngineerH2Revenue(input: ReverseEngineerInput): ReverseEngineerOutput | null {
  const { targetFullYearEps, q1Eps, q2Eps, shares, h2NetMargin } = input;
  if (!shares || shares <= 0 || !h2NetMargin || h2NetMargin <= 0) return null;

  const h2RequiredEps = targetFullYearEps - q1Eps - q2Eps;
  if (h2RequiredEps <= 0) return null;

  const h2RequiredNetIncome = h2RequiredEps * shares;
  const h2RequiredRevenue = h2RequiredNetIncome / h2NetMargin;

  const q3SuggestedRevenue = h2RequiredRevenue * 0.47;
  const q4SuggestedRevenue = h2RequiredRevenue * 0.53;

  return {
    h2RequiredEps,
    h2RequiredNetIncome,
    h2RequiredRevenue,
    q3SuggestedRevenue,
    q4SuggestedRevenue,
    q3MonthlyAvg: q3SuggestedRevenue / 3,
    q4MonthlyAvg: q4SuggestedRevenue / 3,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 過度樂觀自動偵測
// ────────────────────────────────────────────────────────────────────────────

export interface OptimisticCheckInput {
  q1Revenue: number;
  q1NetMargin: number;
  q2Revenue: number;
  q3Revenue: number;
  q4Revenue: number;
  q2NetMargin: number;
  q3NetMargin: number;
  q4NetMargin: number;
  /** 市場共識全年 EPS 上緣（可選 — 沒給就 skip 該檢查） */
  marketConsensusEpsUpper?: number;
  fullYearEps: number;
}

export type OptimisticFlag =
  | 'q3_revenue_jump_over_50pct_vs_q2'
  | 'q4_revenue_jump_over_20pct_vs_q3'
  | 'q2_margin_above_q1_by_3pp'
  | 'q3_margin_above_q1_by_3pp'
  | 'q4_margin_above_q1_by_3pp'
  | 'fullyear_eps_above_consensus_upper_by_15pct';

/**
 * 用「不要過度樂觀」規則自動偵測情境假設是否激進。
 * 回傳觸發的 flag 清單 — 在 reasoning 內必須說明，否則禁止用此情境當中性/合理結論。
 */
export function detectOverlyOptimistic(input: OptimisticCheckInput): OptimisticFlag[] {
  const flags: OptimisticFlag[] = [];

  if (input.q2Revenue > 0 && input.q3Revenue > input.q2Revenue * 1.5) {
    flags.push('q3_revenue_jump_over_50pct_vs_q2');
  }
  if (input.q3Revenue > 0 && input.q4Revenue > input.q3Revenue * 1.2) {
    flags.push('q4_revenue_jump_over_20pct_vs_q3');
  }
  if (input.q2NetMargin > input.q1NetMargin + 0.03) {
    flags.push('q2_margin_above_q1_by_3pp');
  }
  if (input.q3NetMargin > input.q1NetMargin + 0.03) {
    flags.push('q3_margin_above_q1_by_3pp');
  }
  if (input.q4NetMargin > input.q1NetMargin + 0.03) {
    flags.push('q4_margin_above_q1_by_3pp');
  }
  if (
    input.marketConsensusEpsUpper &&
    input.fullYearEps > input.marketConsensusEpsUpper * 1.15
  ) {
    flags.push('fullyear_eps_above_consensus_upper_by_15pct');
  }

  return flags;
}

const OPTIMISTIC_FLAG_LABEL: Record<OptimisticFlag, string> = {
  q3_revenue_jump_over_50pct_vs_q2: 'Q3 營收 > Q2 × 150%（季增 50% 以上需額外依據）',
  q4_revenue_jump_over_20pct_vs_q3: 'Q4 營收 > Q3 × 120%（季增 20% 以上需額外依據）',
  q2_margin_above_q1_by_3pp: 'Q2 淨利率高於 Q1 達 3pp 以上',
  q3_margin_above_q1_by_3pp: 'Q3 淨利率高於 Q1 達 3pp 以上',
  q4_margin_above_q1_by_3pp: 'Q4 淨利率高於 Q1 達 3pp 以上',
  fullyear_eps_above_consensus_upper_by_15pct: '全年 EPS 高於市場共識上緣 15% 以上',
};

export function describeOptimisticFlag(flag: OptimisticFlag): string {
  return OPTIMISTIC_FLAG_LABEL[flag];
}
