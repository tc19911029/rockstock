import { adaptFundamentalRows } from '@/lib/scanner/fundamentalScanAdapter';
import { createEmptyDiagnostics, mergeDiagnostics, recordScanRejection } from '@/lib/scanner/types';
import {
  directIntradayDate,
  directPostCloseDate,
  scanPostCloseStorageLocation,
  scanStrategyNamespace,
} from '@/lib/storage/scanStorage';
import { step1PoolStorageKey } from '@/lib/scanner/step1Pool';

describe('scanner audit contracts', () => {
  test('V 軌分數不污染 0–6 六條件欄位', () => {
    const [result] = adaptFundamentalRows([{
      symbol: '2330.TW', name: '測試', todayPrice: 100,
      breakdown: { total: 88, grade: 'A' }, baseUpside: 0.2,
    }], 'TW', '2026-08-17T08:00:00.000Z');
    expect(result.sixConditionsScore).toBe(0);
    expect(result.strategyScore).toBe(88);
    expect(result.strategyScoreScale).toBe(100);
  });

  test('拒絕帳本合併時保留逐 gate 計數與樣本', () => {
    const a = createEmptyDiagnostics();
    const b = createEmptyDiagnostics();
    recordScanRejection(a, 'A', 'elimination', ['淘汰8']);
    recordScanRejection(b, 'B', 'elimination', ['淘汰10']);
    recordScanRejection(b, 'C', 'kd_declining', ['K向下']);
    const merged = mergeDiagnostics(a, b);
    expect(merged.filteredOut).toBe(3);
    expect(merged.rejectionCounts).toEqual({ elimination: 2, kd_declining: 1 });
    expect(merged.rejectionSamples).toHaveLength(3);
  });

  test('非預設策略取得獨立安全 namespace', () => {
    expect(scanStrategyNamespace('zhu-pure-book')).toBeNull();
    expect(scanStrategyNamespace('custom-growth-v2')).toBe('custom-growth-v2');
    expect(scanStrategyNamespace('custom growth / v2')).not.toBe(scanStrategyNamespace('custom-growth-v2'));
    expect(scanStrategyNamespace('策略甲')).toMatch(/^strategy-/);
    expect(scanPostCloseStorageLocation('TW', 'long', 'daily', '2026-08-17')).toEqual({
      blobPath: 'scans/TW/long/daily/2026-08-17.json',
      localName: 'scan-TW-long-daily-2026-08-17.json',
    });
    const customNs = scanStrategyNamespace('custom growth / v2');
    expect(scanPostCloseStorageLocation('TW', 'long', 'daily', '2026-08-17', 'custom growth / v2')).toEqual({
      blobPath: `scans/TW/long/daily/strategies/${customNs}/2026-08-17.json`,
      localName: `scan-TW-long-daily-strategy-${customNs}-2026-08-17.json`,
    });
  });

  test('Step1 pool 也使用策略 namespace，不會被同日其他策略覆蓋', () => {
    expect(step1PoolStorageKey('TW', '2026-08-17', 'zhu-pure-book'))
      .toBe('step1-pool/TW/2026-08-17.json');
    const custom = step1PoolStorageKey('TW', '2026-08-17', 'custom growth / v2');
    expect(custom).toMatch(/^step1-pool\/TW\/strategies\/custom-growth-v2-[a-z0-9]+\/2026-08-17\.json$/);
    expect(custom).not.toBe(step1PoolStorageKey('TW', '2026-08-17', 'custom-growth-v2'));
  });

  test('預設策略的直接檔案解析不會吃到 strategies 子樹', () => {
    const blobPrefix = 'scans/TW/long/daily/';
    expect(directPostCloseDate('scans/TW/long/daily/2026-08-17.json', blobPrefix)).toBe('2026-08-17');
    expect(directPostCloseDate('scans/TW/long/daily/strategies/other/2026-08-17.json', blobPrefix)).toBeNull();
    expect(directIntradayDate('scans/TW/long/daily/2026-08-17/intraday/132001.json', blobPrefix, '/')).toBe('2026-08-17');
    expect(directIntradayDate('scans/TW/long/daily/strategies/other/2026-08-17/intraday/132001.json', blobPrefix, '/')).toBeNull();

    const localPrefix = 'scan-TW-long-daily-';
    expect(directPostCloseDate('scan-TW-long-daily-2026-08-17.json', localPrefix)).toBe('2026-08-17');
    expect(directPostCloseDate('scan-TW-long-daily-strategy-other-2026-08-17.json', localPrefix)).toBeNull();
    expect(directIntradayDate('scan-TW-long-daily-2026-08-17-intraday-132001.json', localPrefix, '-')).toBe('2026-08-17');
    expect(directIntradayDate('scan-TW-long-daily-strategy-other-2026-08-17-intraday-132001.json', localPrefix, '-')).toBeNull();
  });
});
