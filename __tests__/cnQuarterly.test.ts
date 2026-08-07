import type { FinancialQuarter } from '@/lib/datasource/EastMoneyFinancials';
import { normalizeCnQuarterlyHistory, sumLatestFourQuarterEps } from '@/lib/valuation/cnQuarterly';

function row(overrides: Partial<FinancialQuarter> & Pick<FinancialQuarter, 'reportDate'>): FinancialQuarter {
  return {
    noticeDate: null,
    revenue: null,
    revenueYoY: null,
    netProfit: null,
    netProfitYoY: null,
    roe: null,
    eps: null,
    bps: null,
    grossMargin: null,
    opCashPerShare: null,
    ...overrides,
  };
}

describe('normalizeCnQuarterlyHistory', () => {
  it('將陸股累計季報轉成單季營收、淨利與 EPS', () => {
    const result = normalizeCnQuarterlyHistory([
      row({ reportDate: '2026-09-30', revenue: 390, netProfit: 39, eps: 3.9 }),
      row({ reportDate: '2026-03-31', revenue: 100, netProfit: 10, eps: 1 }),
      row({ reportDate: '2026-06-30', revenue: 230, netProfit: 23, eps: 2.3 }),
    ], 10);

    expect(result.map(q => q.quarter)).toEqual(['2026Q3', '2026Q2', '2026Q1']);
    expect(result[0]).toMatchObject({ revenue: 160, netIncome: 16, eps: 1.6, netMargin: 0.1 });
    expect(result[1]).toMatchObject({ revenue: 130, netIncome: 13, eps: 1.3, netMargin: 0.1 });
    expect(result[2]).toMatchObject({ revenue: 100, netIncome: 10, eps: 1, netMargin: 0.1 });
  });

  it('缺股數時以公告累計 EPS 差額作為單季 EPS', () => {
    const result = normalizeCnQuarterlyHistory([
      row({ reportDate: '2026-06-30', eps: 2.8 }),
      row({ reportDate: '2026-03-31', eps: 1.2 }),
    ], null);

    expect(result[0].eps).toBeCloseTo(1.6);
    expect(result[1].eps).toBeCloseTo(1.2);
  });

  it('只在四個單季 EPS 都完整時加總 TTM', () => {
    const result = normalizeCnQuarterlyHistory([
      row({ reportDate: '2025-12-31', eps: 4.6 }),
      row({ reportDate: '2025-09-30', eps: 3.3 }),
      row({ reportDate: '2025-06-30', eps: 2.1 }),
      row({ reportDate: '2025-03-31', eps: 1 }),
    ], null);

    expect(sumLatestFourQuarterEps(result)).toBeCloseTo(4.6);
    expect(sumLatestFourQuarterEps(result.slice(0, 3))).toBeNull();
  });
});
