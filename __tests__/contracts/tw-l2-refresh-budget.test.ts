import fs from 'fs';
import path from 'path';

const source = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

describe('TW L2 full-market refresh budget', () => {
  test('MIS 全市場代理優先、維持低併發並減少批次數', () => {
    const realtime = source('lib/datasource/TWSERealtime.ts');

    expect(realtime).toContain('const MIS_BATCH_SIZE = 100');
    expect(realtime).toContain('const MIS_CONCURRENCY = 1');
    expect(realtime).toMatch(/headers: MIS_HEADERS, timeoutMs: 12000, proxyFirst: true/);
  });

  test('TW 完整 provider 的期限可覆蓋整輪，但不改 CN 的預設期限', () => {
    const cache = source('lib/datasource/IntradayCache.ts');

    expect(cache).toContain('const PROVIDER_TIMEOUT_MS = 12_000');
    expect(cache).toContain('const TW_MIS_PROVIDER_TIMEOUT_MS = 35_000');
    expect(cache).toContain('timeoutMs: TW_MIS_PROVIDER_TIMEOUT_MS');
  });

  test('沒有任何今日有效報價時不得用舊 quotes 製造新 updatedAt', () => {
    const cache = source('lib/datasource/IntradayCache.ts');
    const noObservationGuard = cache.indexOf('if (finalMap.size === 0) return []');
    const previousSnapshotRead = cache.indexOf("readIntradaySnapshot('TW', todayTW)");

    expect(noObservationGuard).toBeGreaterThan(-1);
    expect(previousSnapshotRead).toBeGreaterThan(noObservationGuard);
  });
});
