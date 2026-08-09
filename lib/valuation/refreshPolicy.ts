import type { FundamentalGroundTruth } from '@/lib/agents/types';
import {
  detectValuationFreshness,
  type CurrentFundamentalSnapshot,
  type ValuationFreshness,
  type ValuationPeriodSnapshot,
} from './freshness';

type ValuationInputs = NonNullable<FundamentalGroundTruth['valuationInputs']>;

export type ValuationRefreshMode = 'reuse' | 'incremental' | 'deep';
export type RequestedValuationRefreshMode = 'auto' | 'incremental' | 'deep';

export interface ValuationRefreshPlan {
  mode: ValuationRefreshMode;
  reason: string;
  freshness: ValuationFreshness | null;
}

export function buildDilutionSignature(events: ValuationInputs['dilutionEvents']): string {
  return events
    .map(event => [
      event.type,
      event.status ?? '',
      event.newShares,
      event.expectedDate ?? '',
      event.announcedAt ?? '',
      event.sourceUrl ?? '',
    ].join('|'))
    .sort()
    .join('||');
}

export function valuationInputsSnapshot(inputs: ValuationInputs): CurrentFundamentalSnapshot {
  const latestFormalPeriod = inputs.latestCumulativeActual?.reportedThrough
    ?? inputs.quarterlyHistory[0]?.quarter
    ?? null;

  return {
    periods: {
      financialReportDate: latestFormalPeriod,
      revenueMonth: inputs.monthlyRevenueHistory[0]?.month ?? null,
      selfReportedPeriod: inputs.selfReportedMonthlyActuals?.[0]?.period ?? null,
    },
    selfReportedMonthlyActuals: inputs.selfReportedMonthlyActuals?.map(item => ({
      period: item.period,
      eps: item.eps,
    })),
    sharesOutstanding: inputs.sharesOutstanding,
    dilutionSignature: buildDilutionSignature(inputs.dilutionEvents),
  };
}

/**
 * 分級更新策略：
 * - 沒有新正式資料且估值未過期：沿用研究，價格衍生欄位由前端即時重算。
 * - 只有月營收／單月自結更新：沿用近期同業與估值模型，只增量更新情境。
 * - 新財報、股數／稀釋改變、品質不合格或超過 7 天：完整深度重算。
 */
export function decideValuationRefresh(options: {
  requestedMode: RequestedValuationRefreshMode;
  previousValuation: ValuationPeriodSnapshot | null;
  previousValuationDate?: string;
  previousAgeDays?: number;
  previousValid?: boolean;
  currentSnapshot: CurrentFundamentalSnapshot;
}): ValuationRefreshPlan {
  const {
    requestedMode,
    previousValuation,
    previousValuationDate,
    previousAgeDays = Number.POSITIVE_INFINITY,
    previousValid = false,
    currentSnapshot,
  } = options;

  if (requestedMode === 'deep') {
    return { mode: 'deep', reason: '使用者要求完整深度重算', freshness: null };
  }
  if (!previousValuation || !previousValid) {
    return { mode: 'deep', reason: '沒有可安全沿用的有效估值', freshness: null };
  }

  const freshness = detectValuationFreshness(
    previousValuation,
    previousValuationDate,
    currentSnapshot,
  );
  if (freshness.hasNewFinancialReport) {
    return { mode: 'deep', reason: '已公布新一期正式財報', freshness };
  }
  if (freshness.hasShareCountChange || freshness.hasNewDilutionEvent) {
    return { mode: 'deep', reason: '股數或潛在稀釋條件已改變', freshness };
  }
  if (previousAgeDays > 7) {
    return { mode: 'deep', reason: '同業估值與情境資料已超過 7 天', freshness };
  }
  if (freshness.hasNewMonthlyRevenue || freshness.hasNewSelfReportedEps) {
    return { mode: 'incremental', reason: '只需納入最新月營收或單月自結', freshness };
  }

  return { mode: 'reuse', reason: '正式資料未變，沿用深度研究並以即時股價重算', freshness };
}
