import { mergeScanBatchResults } from '@/lib/scanner/batchMerge';
import { combineStep1Pools, type Step1Pool } from '@/lib/scanner/step1Pool';

const pool = (symbols: string[], total: number): Step1Pool => ({
  market: 'TW',
  date: '2026-08-05',
  symbols,
  generatedAt: '2026-08-05T00:00:00.000Z',
  stats: { total, passSixCond: symbols.length, passProhib: symbols.length, passElim: symbols.length },
});

describe('scanner batch merge', () => {
  test('Step 1 池累加所有批次並依 symbol 去重', () => {
    const merged = combineStep1Pools(pool(['2330.TW', '2317.TW'], 500), pool(['2317.TW', '2454.TW'], 500));
    expect(merged.symbols).toEqual(['2317.TW', '2330.TW', '2454.TW']);
    expect(merged.stats.total).toBe(1000);
    expect(merged.stats.passElim).toBe(4);
  });

  test('正式掃描結果保留前批並讓新批同 symbol 覆蓋', () => {
    const merged = mergeScanBatchResults(
      [{ symbol: 'A', sixConditionsScore: 3, changePercent: 1 }, { symbol: 'B', sixConditionsScore: 2, changePercent: 1 }],
      [{ symbol: 'B', sixConditionsScore: 5, changePercent: 2 }, { symbol: 'C', sixConditionsScore: 1, changePercent: 8 }],
    );
    expect(merged.map((item) => item.symbol)).toEqual(['B', 'A', 'C']);
    expect(merged.find((item) => item.symbol === 'B')?.sixConditionsScore).toBe(5);
  });
});
