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

  test('台股收盤顯示可用暫定 L2，但不得冒充 official final', () => {
    const single = source('app/api/stock/quote/route.ts');
    const portfolio = source('app/api/portfolio/quotes/route.ts');
    const realtime = source('app/api/realtime/route.ts');
    const chart = source('app/api/stock/route.ts');
    expect(single).not.toContain("source: 'mis-final'");
    expect(single).not.toContain("source: 'l2-final'");
    expect(single).toContain("source: 'l2-provisional-close'");
    expect(portfolio).toContain("'l2-provisional-close'");
    expect(realtime).toContain("source: 'l2-provisional-close'");
    expect(chart).toContain("twNeedsProvisionalClose");
    expect(portfolio).toContain("const twLive = isMarketOpen('TW')");
    expect(portfolio).toContain('fetchTWDisplayQuotes(twEntries)');
    expect(portfolio).toContain("l1?.asOf === expectedDate");
  });

  test('TW 排程只在 13:30／13:35 定格 L2，14:15 起每五分鐘重試官方 L1', () => {
    const scheduler = source('instrumentation.node.ts');
    expect(scheduler).toContain("twClosingL2Attempted: { '13:30': '', '13:35': '' }");
    expect(scheduler).toContain("'/api/cron/update-intraday?market=TW&force=1'");
    expect(scheduler).toContain("const triggerMin = market === 'TW' ? 1415 : 1545");
    expect(scheduler).toContain('lastL1SnapshotAttemptAt');
    expect(scheduler).toContain('/api/cron/audit-l1-l2-consistency?market=${market}');
  });

  test('TW 正式 settlement 只能由官方錨寫入', () => {
    const policy = source('lib/datasource/eodSettlePolicy.ts');
    const settleScript = source('scripts/eod-settle.ts');
    expect(policy).toContain('return result.officialAnchor === true');
    expect(policy).not.toContain("officialAnchor === true ||");
    expect(settleScript).toContain('const verified = result.officialAnchor === true');
    expect(settleScript).not.toContain('result.officialAnchor || (result.independentAgree ?? 0) >= 2');
  });

  test('官方收盤價可修正同日既有的暫時價', () => {
    const append = source('app/api/cron/append-from-snapshot/route.ts');
    expect(append).toContain("if (existing.lastDate === date)");
    expect(append).toContain("existing.candles.filter(candle => candle.date !== date)");
    expect(append).toContain("{ trustedOfficial: true }");
    expect(append).toContain('fetchTwseIndexCandles');
    expect(append).toContain('fetchTpexIndexCandles');
    expect(append).not.toContain('fetchTWIndexQuote');
  });
});
