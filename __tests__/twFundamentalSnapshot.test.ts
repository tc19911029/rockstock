import {
  financialRowsToQuarterHistory,
  mergeOfficialQuarter,
} from '@/lib/strategy/fundamentalRevaluation/twSnapshotSource';

describe('TW fundamental snapshot source', () => {
  test('把 FinMind key/value 快照組成單季財報', () => {
    const rows = financialRowsToQuarterHistory([
      { date: '2026-03-31', type: 'Revenue', value: 100 },
      { date: '2026-03-31', type: 'GrossProfit', value: 40 },
      { date: '2026-03-31', type: 'IncomeAfterTaxes', value: 20 },
      { date: '2026-03-31', type: 'EPS', value: 2 },
    ]);
    expect(rows[0]).toMatchObject({
      quarter: '2026-03-31', revenue: 100, grossProfit: 40,
      netIncome: 20, eps: 2, netMargin: 0.2, grossMargin: 0.4,
    });
  });

  test('將官方 Q2 累計數扣除 Q1，轉成單季口徑', () => {
    const merged = mergeOfficialQuarter([
      {
        quarter: '2026-03-31', revenue: 7_000_000_000, grossProfit: 2_000_000_000,
        netIncome: 400_000_000, eps: 1.3, netMargin: 0.057, grossMargin: 0.286,
      },
    ], {
      rocYear: 115,
      season: 2,
      code: '1215',
      industry: '食品工業',
      eps: 3.4,
      revenue: 15_000_000,
      operatingIncome: 1_300_000,
      netIncome: 1_000_000,
      netMargin: null,
      operatingMargin: null,
    });
    expect(merged[0]).toMatchObject({
      quarter: '2026-06-30', revenue: 8_000_000_000,
      netIncome: 600_000_000, eps: 2.1,
    });
  });

  test('本地已經有同一期時不以較不完整的官方列覆寫', () => {
    const history = [{
      quarter: '2026-06-30', revenue: 8, grossProfit: 3,
      netIncome: 2, eps: 1, netMargin: 0.25, grossMargin: 0.375,
    }];
    expect(mergeOfficialQuarter(history, {
      rocYear: 115, season: 2, code: 'x', industry: '', eps: 3,
      revenue: 10, operatingIncome: 1, netIncome: 4,
      netMargin: null, operatingMargin: null,
    })).toBe(history);
  });
});
