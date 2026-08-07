export interface CurrentFundamentalSnapshot {
  eps?: number | null;
  epsYtd?: number | null;
  revenueLatest?: number | null;
  selfReportedMonthlyActuals?: Array<{ period: string; eps: number }>;
  sharesOutstanding?: number | null;
  dilutionSignature?: string | null;
  periods?: {
    financialReportDate?: string | null;
    revenueMonth?: string | null;
    selfReportedPeriod?: string | null;
  };
}

export interface ValuationPeriodSnapshot {
  dataAsOf?: {
    financialReportPeriod?: string;
    monthlyRevenuePeriod?: string;
    selfReportedPeriod?: string;
    sharesOutstanding?: number;
    dilutionSignature?: string;
  };
  monthlyEpsEstimate?: { month: string };
  monthlyEpsActuals?: Array<{ period: string }>;
}

export interface ValuationFreshness {
  hasNewData: boolean;
  hasNewFinancialReport: boolean;
  hasNewMonthlyRevenue: boolean;
  hasNewSelfReportedEps: boolean;
  hasShareCountChange: boolean;
  hasNewDilutionEvent: boolean;
  financialReportDate: string | null;
  monthlyRevenuePeriod: string | null;
  selfReportedPeriod: string | null;
  sharesOutstanding: number | null;
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
  const selfReportedPeriod = monthKey(
    current?.periods?.selfReportedPeriod ?? current?.selfReportedMonthlyActuals?.[0]?.period,
  );

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

  const savedSelfReportedPeriod = monthKey(
    valuation.dataAsOf?.selfReportedPeriod
      ?? valuation.monthlyEpsActuals?.[0]?.period,
  );
  // 若舊估值完全沒有自結欄位，只要目前抓到自結實績即視為新資料；不能因同月營收已納入
  // 就把自結 EPS 當成「沒有更新」。
  const hasNewSelfReportedEps = Boolean(
    selfReportedPeriod && (
      savedSelfReportedPeriod
        ? selfReportedPeriod > savedSelfReportedPeriod
        : true
    ),
  );

  const sharesOutstanding = current?.sharesOutstanding ?? null;
  const savedShares = valuation.dataAsOf?.sharesOutstanding;
  // 舊估值沒留下股數時，只要目前能取得股數就保守視為需要重算；避免除權配股後仍沿用舊 EPS。
  const hasShareCountChange = Boolean(
    sharesOutstanding != null && sharesOutstanding > 0 && (
      savedShares == null || Math.abs(sharesOutstanding - savedShares) >= 1
    ),
  );
  const dilutionSignature = current?.dilutionSignature ?? null;
  const savedDilutionSignature = valuation.dataAsOf?.dilutionSignature;
  const hasNewDilutionEvent = Boolean(
    dilutionSignature && (
      savedDilutionSignature == null || dilutionSignature !== savedDilutionSignature
    ),
  );

  return {
    hasNewData: hasNewFinancialReport || hasNewMonthlyRevenue || hasNewSelfReportedEps
      || hasShareCountChange || hasNewDilutionEvent,
    hasNewFinancialReport,
    hasNewMonthlyRevenue,
    hasNewSelfReportedEps,
    hasShareCountChange,
    hasNewDilutionEvent,
    financialReportDate,
    monthlyRevenuePeriod,
    selfReportedPeriod,
    sharesOutstanding,
  };
}
