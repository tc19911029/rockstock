import { deriveOverallLevel, type OverallHealthSignal } from '@/lib/health/overallLevel';

function healthy(overrides: Partial<OverallHealthSignal> = {}): OverallHealthSignal {
  return {
    market: 'TW', ok: true, health: 'good', expectedDate: '2026-08-07',
    reportDate: '2026-08-07', coverageRate: 0.99, totalStocks: 1900, stocksStale: 0,
    l2AlertLevel: 'none', l4Status: 'fresh', l4LastDate: '2026-08-07',
    limitUpConsistencyLevel: 'ok', l1l2ConsistencyLevel: 'ok', strategyStatus: 'ready', ...overrides,
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

  test('L1/L2 嚴重不一致為紅燈，缺少收盤快照為黃燈', () => {
    expect(deriveOverallLevel([healthy({ l1l2ConsistencyLevel: 'critical' })])).toBe('red');
    expect(deriveOverallLevel([healthy({ l1l2ConsistencyLevel: 'unavailable' })])).toBe('yellow');
  });

  test('全部通過才顯示綠燈', () => {
    expect(deriveOverallLevel([healthy()])).toBe('green');
  });
});
