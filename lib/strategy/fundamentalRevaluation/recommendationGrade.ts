/**
 * 推薦等級與旗標判定（2026-05-27）
 *
 * 從 bundle + scenarios 反推 StrategyFlag 陣列；scoring.ts buildBreakdown 會用 flag 微調 grade。
 *
 * 把「判斷規則」集中在這個檔，避免散落在 twPipeline / cnPipeline。
 */

import type { ScenarioResult, ScenarioKey } from '@/lib/valuation/types';
import type {
  StrategyFlag,
  TwFundamentalBundle,
  CnFundamentalBundle,
} from './types';

/** 中性情境是否有足夠 upside（≥ 20%） */
function baseHasUpside(scenarios: Record<ScenarioKey, ScenarioResult>): boolean {
  return scenarios.base.upside >= 0.2;
}

/** 樂觀有 upside 但中性沒有（≥ 20%） */
function onlyOptimisticHasUpside(scenarios: Record<ScenarioKey, ScenarioResult>): boolean {
  return scenarios.optimistic.upside >= 0.2 && scenarios.base.upside < 0.2;
}

export function deriveTwFlags(
  bundle: TwFundamentalBundle,
  scenarios: Record<ScenarioKey, ScenarioResult>,
): StrategyFlag[] {
  const flags: StrategyFlag[] = [];

  if (baseHasUpside(scenarios)) flags.push('undervalued');
  if (onlyOptimisticHasUpside(scenarios)) flags.push('only_optimistic_has_upside');

  // 樂觀情境也算超過現價 → 估值偏滿
  if (scenarios.base.upside < 0 && scenarios.optimistic.upside < 0.1) {
    flags.push('valuation_stretched');
  }

  if (bundle.riskFlags.includes('one_time_gain')) flags.push('one_time_gain');
  if (bundle.riskFlags.includes('cyclical_peak')) flags.push('cyclical_peak');
  if (bundle.riskFlags.includes('dilution_pending')) flags.push('dilution_pending');

  // 高成長
  if (
    (bundle.latestMonthRevenueYoY != null && bundle.latestMonthRevenueYoY > 30) ||
    (bundle.latestQuarterEpsYoY != null && bundle.latestQuarterEpsYoY > 30)
  ) {
    flags.push('high_growth');
  }

  // 本業 TTM EPS 為負 → 切換 PB 評估
  if (bundle.ttmEps != null && bundle.ttmEps <= 0) {
    flags.push('using_pb_evaluation');
  }

  // 季報未公告（資料月份比股價舊太多）→ 等下一季驗證
  if (bundle.quarters.length === 0 || bundle.latestQuarterEps == null) {
    flags.push('awaiting_financial_validation');
  }

  return flags;
}

export function deriveCnFlags(
  bundle: CnFundamentalBundle,
  scenarios: Record<ScenarioKey, ScenarioResult>,
): StrategyFlag[] {
  const flags: StrategyFlag[] = [];

  if (baseHasUpside(scenarios)) flags.push('undervalued');
  if (onlyOptimisticHasUpside(scenarios)) flags.push('only_optimistic_has_upside');

  if (scenarios.base.upside < 0 && scenarios.optimistic.upside < 0.1) {
    flags.push('valuation_stretched');
  }

  if (bundle.riskFlags.includes('one_time_gain')) flags.push('one_time_gain');
  if (bundle.riskFlags.includes('cyclical_peak')) flags.push('cyclical_peak');

  if (
    (bundle.latestQuarterRevenueYoY != null && bundle.latestQuarterRevenueYoY > 30) ||
    (bundle.latestQuarterNetProfitParentYoY != null && bundle.latestQuarterNetProfitParentYoY > 50)
  ) {
    flags.push('high_growth');
  }

  if (bundle.ttmEps != null && bundle.ttmEps <= 0) {
    flags.push('using_pb_evaluation');
  }

  // 扣非品質不佳（< 50%）→ 等下季驗證
  if (bundle.deductedNetProfitRatio != null && bundle.deductedNetProfitRatio < 0.5) {
    flags.push('awaiting_financial_validation');
  }

  return flags;
}

// ────────────────────────────────────────────────────────────────────────────
// 推薦等級中文化（UI 用）
// ────────────────────────────────────────────────────────────────────────────

import type { RecommendationGrade } from './types';

const GRADE_LABEL: Record<RecommendationGrade, string> = {
  A_core: 'A 級補漲核心',
  B_candidate: 'B 級候選',
  C_watch: 'C 級觀察',
  D_weak: '弱候選',
  excluded: '排除',
};

export function gradeLabel(g: RecommendationGrade): string {
  return GRADE_LABEL[g];
}

const FLAG_LABEL: Record<StrategyFlag, string> = {
  undervalued: '低估',
  high_growth: '高成長',
  cyclical_peak: '景氣循環高峰',
  one_time_gain: '一次性收益',
  valuation_stretched: '估值偏滿',
  awaiting_financial_validation: '等財報驗證',
  only_optimistic_has_upside: '僅樂觀有空間',
  using_pb_evaluation: '用 PB 評估',
  data_conflict: '資料衝突',
  dilution_pending: '增資稀釋',
};

export function flagLabel(f: StrategyFlag): string {
  return FLAG_LABEL[f];
}
