export interface CnFinancialRow {
  reportDate: string;
  noticeDate?: string | null;
  revenue?: number | null;
  revenueYoY?: number | null;
  netProfit?: number | null;
  netProfitYoY?: number | null;
  roe?: number | null;
  eps?: number | null;
  bps?: number | null;
  grossMargin?: number | null;
}

export interface CnValuationSummary {
  ttmPe?: number | null;
  dynamicPe?: number | null;
  staticPe?: number | null;
  pbRatio?: number | null;
  totalShares?: number | null;
}

export interface CnFinancialsPayload {
  ok?: boolean;
  error?: string;
  financials?: CnFinancialRow[];
  valuation?: CnValuationSummary | null;
}

export interface CnSidebarFundamentals {
  market: 'CN';
  eps?: number;
  epsYtd?: number | null;
  grossMargin?: number;
  netMargin?: number;
  per?: number;
  pbr?: number;
  sharesOutstanding?: number | null;
  periods: {
    financialReportDate: string;
    valuationDate: string | null;
  };
  cnFinancials: CnFinancialRow[];
  cnValuation: CnValuationSummary | null;
}

/**
 * 將陸股原始財報 API 轉成首頁基本面面板可直接顯示的 fallback。
 *
 * 這層只負責「已有正式財報時不要顯示成完全沒資料」；不在前端推估
 * Forward EPS，也不把跨增資期間的報表 EPS 相加成 TTM EPS。
 */
export function mapCnFinancialsToSidebar(payload: CnFinancialsPayload | null | undefined): CnSidebarFundamentals | null {
  if (!payload?.ok || !Array.isArray(payload.financials) || payload.financials.length === 0) return null;

  const financials = payload.financials
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.reportDate))
    .slice()
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  const latest = financials[0];
  if (!latest) return null;

  const finite = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  const netMargin = finite(latest.netProfit) && finite(latest.revenue) && latest.revenue !== 0
    ? latest.netProfit / latest.revenue * 100
    : undefined;

  return {
    market: 'CN',
    ...(finite(latest.eps) ? { eps: latest.eps, epsYtd: latest.eps } : {}),
    ...(finite(latest.grossMargin) ? { grossMargin: latest.grossMargin } : {}),
    ...(finite(netMargin) ? { netMargin } : {}),
    ...(finite(payload.valuation?.ttmPe) ? { per: payload.valuation.ttmPe } : {}),
    ...(finite(payload.valuation?.pbRatio) ? { pbr: payload.valuation.pbRatio } : {}),
    sharesOutstanding: payload.valuation?.totalShares ?? null,
    periods: {
      financialReportDate: latest.reportDate,
      valuationDate: payload.valuation ? new Date().toISOString().slice(0, 10) : null,
    },
    cnFinancials: financials,
    cnValuation: payload.valuation ?? null,
  };
}
