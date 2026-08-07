import { detectValuationFreshness } from '@/lib/valuation/freshness';

describe('detectValuationFreshness', () => {
  it('detects 3006 Q2 report and July revenue missing from an old valuation', () => {
    const result = detectValuationFreshness(
      { monthlyEpsEstimate: { month: '2026-06' } },
      '2026-06-04',
      {
        eps: 20.21,
        epsYtd: 27.58,
        revenueLatest: 6_784_662_000,
        periods: { financialReportDate: '2026-06-30', revenueMonth: '2026-07-01' },
      },
    );

    expect(result.hasNewFinancialReport).toBe(true);
    expect(result.hasNewMonthlyRevenue).toBe(true);
  });

  it('detects 3661 June revenue while keeping its Q1 report unchanged', () => {
    const result = detectValuationFreshness(
      { monthlyEpsEstimate: { month: '2026-05' } },
      '2026-05-28',
      {
        eps: 17.55,
        periods: { financialReportDate: '2026-03-31', revenueMonth: '2026-06-01' },
      },
    );

    expect(result.hasNewFinancialReport).toBe(false);
    expect(result.hasNewMonthlyRevenue).toBe(true);
    expect(result.monthlyRevenuePeriod).toBe('2026-06');
  });

  it('uses saved dataAsOf for new-schema valuations', () => {
    const result = detectValuationFreshness(
      { dataAsOf: { financialReportPeriod: '2026Q2', monthlyRevenuePeriod: '2026-06' } },
      '2026-07-20',
      { periods: { financialReportDate: '2026-06-30', revenueMonth: '2026-06-01' } },
    );

    expect(result.hasNewData).toBe(false);
  });

  it('invalidates a valuation when a same-month self-reported EPS appears after revenue', () => {
    const result = detectValuationFreshness(
      { dataAsOf: { financialReportPeriod: '2026Q2', monthlyRevenuePeriod: '2026-07' } },
      '2026-08-04',
      {
        periods: {
          financialReportDate: '2026-06-30',
          revenueMonth: '2026-07-01',
          selfReportedPeriod: '2026-07',
        },
        selfReportedMonthlyActuals: [{ period: '2026-07', eps: 11.61 }],
      },
    );

    expect(result.hasNewMonthlyRevenue).toBe(false);
    expect(result.hasNewSelfReportedEps).toBe(true);
    expect(result.hasNewData).toBe(true);
  });

  it('does not invalidate when the valuation records the latest self-reported period', () => {
    const result = detectValuationFreshness(
      { dataAsOf: { financialReportPeriod: '2026Q2', monthlyRevenuePeriod: '2026-07', selfReportedPeriod: '2026-07' } },
      '2026-08-08',
      {
        periods: {
          financialReportDate: '2026-06-30',
          revenueMonth: '2026-07-01',
          selfReportedPeriod: '2026-07',
        },
      },
    );

    expect(result.hasNewSelfReportedEps).toBe(false);
    expect(result.hasNewData).toBe(false);
  });
});
