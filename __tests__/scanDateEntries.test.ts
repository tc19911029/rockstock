import {
  deduplicateScanDateEntries,
  type ScanDateEntry,
} from '@/lib/storage/scanStorage';

function entry(overrides: Partial<ScanDateEntry> = {}): ScanDateEntry {
  return {
    market: 'TW',
    date: '2026-09-04',
    direction: 'long',
    mtfMode: 'daily',
    resultCount: 5,
    scanTime: '2026-09-04T01:50:00.000Z',
    ...overrides,
  };
}

describe('deduplicateScanDateEntries', () => {
  test('保留同日非空結果，同時回報較新的空掃描嘗試', () => {
    const [result] = deduplicateScanDateEntries([
      entry(),
      entry({ resultCount: 0, scanTime: '2026-09-04T02:03:00.000Z' }),
    ]);

    expect(result.resultCount).toBe(5);
    expect(result.scanTime).toBe('2026-09-04T01:50:00.000Z');
    expect(result.latestAttemptCount).toBe(0);
    expect(result.latestAttemptTime).toBe('2026-09-04T02:03:00.000Z');
  });

  test('較新的非空結果同時成為顯示結果與最新嘗試', () => {
    const [result] = deduplicateScanDateEntries([
      entry(),
      entry({ resultCount: 2, scanTime: '2026-09-04T02:03:00.000Z' }),
    ]);

    expect(result.resultCount).toBe(2);
    expect(result.scanTime).toBe('2026-09-04T02:03:00.000Z');
    expect(result.latestAttemptCount).toBe(2);
    expect(result.latestAttemptTime).toBe('2026-09-04T02:03:00.000Z');
  });

  test('不同掃描模式不互相合併', () => {
    const results = deduplicateScanDateEntries([
      entry({ mtfMode: 'daily' }),
      entry({ mtfMode: 'mtf' }),
    ]);

    expect(results).toHaveLength(2);
  });
});
