import { mapCnFinancialsToSidebar } from '@/lib/valuation/cnSidebarFallback';

describe('mapCnFinancialsToSidebar', () => {
  it('陸股已有正式財報時建立首頁 fallback，不要求先有 Agent 或估值快照', () => {
    const result = mapCnFinancialsToSidebar({
      ok: true,
      financials: [
        {
          reportDate: '2026-03-31',
          revenue: 8_888_335_184.08,
          revenueYoY: 199.07,
          netProfit: 1_093_463_056.14,
          netProfitYoY: 330.29,
          roe: 10.94,
          eps: 1.13,
          grossMargin: 21.49,
        },
      ],
      valuation: null,
    });

    expect(result).toMatchObject({
      market: 'CN',
      eps: 1.13,
      epsYtd: 1.13,
      grossMargin: 21.49,
      periods: { financialReportDate: '2026-03-31', valuationDate: null },
    });
    expect(result?.netMargin).toBeCloseTo(12.3022, 3);
    expect(result?.cnFinancials).toHaveLength(1);
  });

  it('沒有正式財報時不偽造 fallback', () => {
    expect(mapCnFinancialsToSidebar({ ok: true, financials: [], valuation: null })).toBeNull();
    expect(mapCnFinancialsToSidebar({ ok: false, financials: [] })).toBeNull();
  });
});
