export interface CurrentFundamentalSnapshot {
  eps?: number | null;
  epsYtd?: number | null;
  revenueLatest?: number | null;
  periods?: {
    financialReportDate?: string | null;
    revenueMonth?: string | null;
  };
}

export interface ValuationPeriodSnapshot {
  dataAsOf?: {
    financialReportPeriod?: string;
    monthlyRevenuePeriod?: string;
  };
  monthlyEpsEstimate?: { month: string };
}

export interface ValuationFreshness {
  hasNewData: boolean;
  hasNewFinancialReport: boolean;
  hasNewMonthlyRevenue: boolean;
  financialReportDate: string | null;
  monthlyRevenuePeriod: string | null;
}

function monthKey(value: string | null | undefined): string | null {
  const match = value?.match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function quarterKey(value: string | null | undefined): number | null {
  const quarter = value?.match(/^(\d{4})Q([1-4])$/i);
  if (quarter) return Number(quarter[1]) * 4 + Number(quarter[2]);
  const date = value?.match(/^(\d{4})-(\d{2})/);
  if (!date) return null;
  return Number(date[1]) * 4 + Math.ceil(Number(date[2]) / 3);
}

/** 比對估值實際採用期別與目前正式資料；舊檔沒有 dataAsOf 時採保守 fallback。 */
export function detectValuationFreshness(
  valuation: ValuationPeriodSnapshot,
  valuationDate: string | undefined,
  current: CurrentFundamentalSnapshot | null | undefined,
): ValuationFreshness {
  const financialReportDate = current?.periods?.financialReportDate ?? null;
  const monthlyRevenuePeriod = monthKey(current?.periods?.revenueMonth);

  const savedFinancial = valuation.dataAsOf?.financialReportPeriod;
  const currentQuarter = quarterKey(financialReportDate);
  const savedQuarter = quarterKey(savedFinancial);
  const hasNewFinancialReport = currentQuarter != null && (
    savedQuarter != null
      ? currentQuarter > savedQuarter
      : Boolean(valuationDate && financialReportDate && financialReportDate > valuationDate)
  );

  const savedMonth = monthKey(
    valuation.dataAsOf?.monthlyRevenuePeriod
      ?? valuation.monthlyEpsEstimate?.month
      ?? valuationDate,
  );
  const hasNewMonthlyRevenue = Boolean(
    monthlyRevenuePeriod && savedMonth && monthlyRevenuePeriod > savedMonth,
  );

  return {
    hasNewData: hasNewFinancialReport || hasNewMonthlyRevenue,
    hasNewFinancialReport,
    hasNewMonthlyRevenue,
    financialReportDate,
    monthlyRevenuePeriod,
  };
}
