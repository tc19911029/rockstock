export type IndustryTemplate =
  | 'high_growth_asic'
  | 'cyclical'
  | 'distributor'
  | 'stable_mature'
  | 'advanced_material'
  | 'consumer_pharma_leader'
  | 'hype_extreme_growth'
  | 'other';

export type ScenarioKey = 'pessimistic' | 'base' | 'optimistic';

export interface QuarterRow {
  quarter: string;
  revenue: number;
  grossProfit?: number;
  netIncome: number;
  eps: number;
  netMargin?: number;
  sharesWeighted?: number;
}

export interface MonthlyRevenueRow {
  month: string;
  revenue: number;
  mom?: number;
  yoy?: number;
}

export interface DilutionEvent {
  type: 'gdr' | 'rights_issue' | 'convertible_bond' | 'employee_option' | 'private_placement';
  /** 尚未確定最終發行數時為 0，但事件仍保留並標示 pending。 */
  newShares: number;
  status?: 'pending' | 'approved' | 'completed' | 'cancelled';
  potentialDilutionPct?: number;
  expectedDate?: string;
  priceIfKnown?: number;
  sourceUrl?: string;
  announcedAt?: string;
  description?: string;
}

export interface PeRange {
  pessimistic: number;
  base: number;
  optimistic: number;
}

export interface ScenarioAssumption {
  q2Revenue?: number;
  q3Revenue?: number;
  q4Revenue?: number;
  q2NetMargin?: number;
  q3NetMargin?: number;
  q4NetMargin?: number;
  partialQuarterRevenue?: number;
}

export interface ScenarioResult {
  q2Eps: number;
  q3Eps: number;
  q4Eps: number;
  fullYearEps: number;
  forwardPe: number;
  fairPe: number;
  fairPrice: number;
  upside: number;
}

export interface DilutionResult {
  originalShares: number;
  newShares: number;
  ratio: number;
  pessimisticDilutedEps: number;
  baseDilutedEps: number;
  optimisticDilutedEps: number;
  pessimisticDilutedPrice: number;
  baseDilutedPrice: number;
  optimisticDilutedPrice: number;
}

export type RiskFlag =
  | 'one_time_gain'
  | 'pb_overheated'
  | 'cyclical_peak'
  | 'forward_pe_misleading'
  | 'dilution_pending'
  | 'margin_declining_while_revenue_growing'
  | 'monthly_revenue_pending'
  | 'aggressive_scenario_assumption'
  | 'foreign_currency_sensitive'
  | 'customer_concentration';

export interface ValuationResult {
  ttmEps: number;
  ttmPe: number;
  scenarios: Record<ScenarioKey, ScenarioResult>;
  dilution: DilutionResult | null;
  riskFlags: RiskFlag[];
  conclusion: 'undervalued' | 'fair' | 'overvalued';
  reasoning: string;
}
