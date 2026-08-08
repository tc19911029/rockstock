import { deriveOverallLevel, type OverallHealthSignal } from '@/lib/health/overallLevel';

function healthy(overrides: Partial<OverallHealthSignal> = {}): OverallHealthSignal {
  return {
    market: 'TW', ok: true, health: 'good', expectedDate: '2026-08-07',
    reportDate: '2026-08-07', coverageRate: 0.99, totalStocks: 1900, stocksStale: 0,
    l2AlertLevel: 'none', l4Status: 'fresh', l4LastDate: '2026-08-07',
    limitUpConsistencyLevel: 'ok', strategyStatus: 'ready', ...overrides,
  };
}

describe('deriveOverallLevel', () => {
  test('30/30 不得顯示綠燈', () => {
    expect(deriveOverallLevel([healthy({ totalStocks: 30, coverageRate: 1 })])).toBe('red');
  });

  test('策略缺漏或 L4 過期都顯示紅燈', () => {
    expect(deriveOverallLevel([healthy({ strategyStatus: 'partial' })])).toBe('red');
    expect(deriveOverallLevel([healthy({ l4Status: 'stale' })])).toBe('red');
  });

  test('全部通過才顯示綠燈', () => {
    expect(deriveOverallLevel([healthy()])).toBe('green');
  });
});
