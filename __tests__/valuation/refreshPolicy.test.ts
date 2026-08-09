import { decideValuationRefresh } from '@/lib/valuation/refreshPolicy';

const previous = {
  dataAsOf: {
    financialReportPeriod: '2026Q2',
    monthlyRevenuePeriod: '2026-06',
    selfReportedPeriod: '2026-06',
    sharesOutstanding: 100_000_000,
    dilutionSignature: '',
  },
};

const current = {
  periods: {
    financialReportDate: '2026Q2',
    revenueMonth: '2026-06-01',
    selfReportedPeriod: '2026-06',
  },
  sharesOutstanding: 100_000_000,
  dilutionSignature: '',
};

describe('valuation refresh policy', () => {
  it('reuses a recent valid valuation when formal inputs are unchanged', () => {
    expect(decideValuationRefresh({
      requestedMode: 'auto',
      previousValuation: previous,
      previousValuationDate: '2026-08-08',
      previousAgeDays: 1,
      previousValid: true,
      currentSnapshot: current,
    }).mode).toBe('reuse');
  });

  it('uses incremental analysis for a new monthly revenue update', () => {
    const result = decideValuationRefresh({
      requestedMode: 'incremental',
      previousValuation: previous,
      previousValuationDate: '2026-08-08',
      previousAgeDays: 1,
      previousValid: true,
      currentSnapshot: {
        ...current,
        periods: { ...current.periods, revenueMonth: '2026-07-01' },
      },
    });

    expect(result.mode).toBe('incremental');
    expect(result.freshness?.hasNewMonthlyRevenue).toBe(true);
  });

  it('requires deep analysis after a new formal report', () => {
    const result = decideValuationRefresh({
      requestedMode: 'auto',
      previousValuation: previous,
      previousValuationDate: '2026-08-08',
      previousAgeDays: 1,
      previousValid: true,
      currentSnapshot: {
        ...current,
        periods: { ...current.periods, financialReportDate: '2026Q3' },
      },
    });

    expect(result.mode).toBe('deep');
    expect(result.freshness?.hasNewFinancialReport).toBe(true);
  });

  it('treats H1 and Q2 as the same formal reporting period', () => {
    const result = decideValuationRefresh({
      requestedMode: 'auto',
      previousValuation: {
        dataAsOf: { ...previous.dataAsOf, financialReportPeriod: '2026H1' },
      },
      previousValuationDate: '2026-08-08',
      previousAgeDays: 1,
      previousValid: true,
      currentSnapshot: current,
    });

    expect(result.freshness?.hasNewFinancialReport).toBe(false);
    expect(result.mode).toBe('reuse');
  });

  it('parses legacy reporting periods that include explanatory text', () => {
    const result = decideValuationRefresh({
      requestedMode: 'auto',
      previousValuation: {
        dataAsOf: {
          ...previous.dataAsOf,
          financialReportPeriod: '2026Q1 formal quarterly report, published 2026-04-28',
        },
      },
      previousValuationDate: '2026-08-08',
      previousAgeDays: 1,
      previousValid: true,
      currentSnapshot: {
        ...current,
        periods: { ...current.periods, financialReportDate: '2026Q1' },
      },
    });

    expect(result.freshness?.hasNewFinancialReport).toBe(false);
    expect(result.mode).toBe('reuse');
  });

  it('requires deep analysis when shares change or the valuation is older than seven days', () => {
    const changedShares = decideValuationRefresh({
      requestedMode: 'auto',
      previousValuation: previous,
      previousAgeDays: 1,
      previousValid: true,
      currentSnapshot: { ...current, sharesOutstanding: 105_000_000 },
    });
    const stale = decideValuationRefresh({
      requestedMode: 'auto',
      previousValuation: previous,
      previousAgeDays: 8,
      previousValid: true,
      currentSnapshot: current,
    });

    expect(changedShares.mode).toBe('deep');
    expect(stale.mode).toBe('deep');
  });

  it('honors an explicit full refresh even when inputs are unchanged', () => {
    expect(decideValuationRefresh({
      requestedMode: 'deep',
      previousValuation: previous,
      previousAgeDays: 0,
      previousValid: true,
      currentSnapshot: current,
    }).mode).toBe('deep');
  });
});
