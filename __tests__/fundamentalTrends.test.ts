import {
  buildCumulativeQuarterTrends,
  buildMonthlyFundamentalTrends,
  buildSingleQuarterTrends,
} from '@/lib/fundamentals/trends';

describe('fundamental trend normalization', () => {
  it('calculates month-over-month and year-over-year using matching periods', () => {
    const result = buildMonthlyFundamentalTrends([
      { period: '2026-02-01', revenue: 132 },
      { period: '2026-01-01', revenue: 120 },
      { period: '2025-02-01', revenue: 110 },
    ]);
    expect(result[0]).toMatchObject({
      period: '2026-02',
      revenueMoM: 10,
      revenueYoY: 20,
      revenueYtdYoY: null,
    });
    expect(result[1].revenueMoM).toBeNull();
  });

  it('calculates cumulative revenue growth only when both years have every month', () => {
    const result = buildMonthlyFundamentalTrends([
      { period: '2026-02-01', revenue: 132 },
      { period: '2026-01-01', revenue: 120 },
      { period: '2025-02-01', revenue: 110 },
      { period: '2025-01-01', revenue: 100 },
    ]);
    expect(result[0].revenueYtdYoY).toBeCloseTo(20, 8);
    expect(result[1].revenueYtdYoY).toBeCloseTo(20, 8);
  });

  it('uses percent change for amounts and percentage-point change for margins', () => {
    const result = buildSingleQuarterTrends([
      { period: '2026-03-31', revenue: 150, netIncome: 30, eps: 1.5, grossMargin: 0.4 },
      { period: '2025-12-31', revenue: 100, netIncome: 10, eps: 1, grossMargin: 35 },
      { period: '2025-03-31', revenue: 120, netIncome: 12, eps: 1.2, grossMargin: 30 },
    ]);
    expect(result[0]).toMatchObject({
      revenueQoQ: 50,
      revenueYoY: 25,
      grossMargin: 40,
      grossMarginQoQ: 5,
      grossMarginYoY: 10,
      netMargin: 20,
      netMarginQoQ: 10,
      netMarginYoY: 10,
      epsQoQ: 50,
    });
    expect(result[0].epsYoY).toBeCloseTo(25, 8);
  });

  it('converts cumulative A-share reports into true single-quarter values first', () => {
    const result = buildCumulativeQuarterTrends([
      { period: '2025-03-31', revenue: 100, netIncome: 10, eps: 0.1, grossMargin: 40 },
      { period: '2025-06-30', revenue: 260, netIncome: 34, eps: 0.34, grossMargin: 35 },
      { period: '2026-03-31', revenue: 120, netIncome: 18, eps: 0.18, grossMargin: 45 },
      { period: '2026-06-30', revenue: 300, netIncome: 48, eps: 0.48, grossMargin: 42 },
    ]);
    expect(result[0]).toMatchObject({
      period: '2026-06-30',
      revenue: 180,
      netMargin: 16.666666666666664,
      eps: 0.3,
      revenueQoQ: 50,
      revenueYoY: 12.5,
    });
    expect(result[0].epsYoY).toBeCloseTo(25, 8);
    expect(result[0].grossMargin).toBeCloseTo(40, 8);
  });
});
