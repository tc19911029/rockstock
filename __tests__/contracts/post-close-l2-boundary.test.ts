import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

describe('post-close L2 boundary', () => {
  test('正式 downloader 不得讀 IntradayCache', () => {
    const route = source('app/api/cron/download-candles/route.ts');
    expect(route).not.toContain('readIntradaySnapshot');
    expect(route).toContain('L2=disabled(post_close)');
  });

  test('BM 盤後 route 不得注入 realtime quotes', () => {
    const route = source('app/api/cron/scan-bm-batch/route.ts');
    expect(route).not.toContain('readIntradaySnapshot');
    expect(route).not.toContain('setRealtimeQuotes(');
  });

  test('統一掃描管線必須以 sessionType gate L2', () => {
    const pipeline = source('lib/scanner/ScanPipeline.ts');
    expect(pipeline).toContain('canInjectL2ForScan(sessionType)');
  });
});
