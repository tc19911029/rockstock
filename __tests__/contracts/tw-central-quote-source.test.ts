import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = (relative: string) => readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('TW central intraday quote source contract', () => {
  test.each([
    'app/api/portfolio/quotes/route.ts',
    'app/api/stock/quote/route.ts',
    'app/api/stock/route.ts',
    'app/api/realtime/route.ts',
    'app/api/scanner/chunk/route.ts',
    'app/api/cron/realtime-scan/route.ts',
    'lib/datasource/MultiMarketProvider.ts',
    'lib/datasource/IndexRealtime.ts',
  ])('%s 不得繞過中央 L2 直接抓台股個股行情', file => {
    const text = source(file);
    expect(text).not.toContain('getTWSERealtimeIntraday(');
    expect(text).not.toContain('getTWSESingleIntraday(');
    expect(text).not.toContain('getFugleQuote(');
    expect(text).not.toContain('mis.twse.com.tw/stock/api/getStockInfo');
  });

  test('中央分鐘輪詢失敗不立即重打，下一分鐘再試', () => {
    const route = source('app/api/cron/update-intraday/route.ts');
    const scheduler = source('instrumentation.node.ts');
    expect(route).toContain("refreshIntradaySnapshot(market, { retryOnEmpty: false })");
    expect(route).toContain("market === 'TW'");
    expect(route).toContain("? isMarketOpen('TW')");
    expect(scheduler).toContain('const nextDelay = L2_REFRESH_INTERVAL_MS');
    expect(scheduler).not.toContain('const degradedIntervalMs = Math.max(5 * 60_000');
    expect(scheduler).not.toContain('TW pre-append L2 refresh');
  });

  test('台股收盤異常只重跑官方封存，不得用 L2 recovery 冒充 final', () => {
    const watchdog = source('app/api/cron/quote-freshness-watchdog/route.ts');
    expect(watchdog).toContain('/api/cron/append-from-snapshot?market=TW&force=1');
    expect(watchdog).not.toContain('/api/cron/update-intraday?market=TW&force=1');
  });

  test('互動題材與粗掃只能讀中央快照，不另觸發全市場刷新', () => {
    expect(source('app/api/themes/live/route.ts')).not.toContain('refreshIntradaySnapshot(');
    expect(source('app/api/scanner/coarse/route.ts')).not.toContain('refreshIntradaySnapshot(');
  });

  test('MIS 批次同時連線數受控，並快取股票代碼清單', () => {
    const realtime = source('lib/datasource/TWSERealtime.ts');
    expect(realtime).toContain('const MIS_CONCURRENCY = 1');
    expect(realtime).toContain('const CODE_UNIVERSE_TTL = 6 * 60 * 60 * 1000');
    expect(realtime).toContain("channels.push(exchange === 'tse' ? 'tse_t00.tw' : 'otc_o00.tw')");
    expect(realtime).toContain('indexSymbol ? d.m : d.v');
  });

  test('台股指數隨個股批次寫入中央快照，不另打 MIS', () => {
    const cache = source('lib/datasource/IntradayCache.ts');
    const provider = source('lib/datasource/MultiMarketProvider.ts');
    expect(cache).not.toContain('fetchTWIndexQuote(todayTW');
    expect(provider).not.toContain("import('./IntradayCache').fetchTWIndexQuote");
    expect(provider).not.toContain("const { fetchTWIndexQuote } = await import('./IntradayCache')");
  });

  test('批次漏回會原樣沿用上一輪，不增加未成交計數', () => {
    const cache = source('lib/datasource/IntradayCache.ts');
    expect(cache).toContain('if (observedSymbols.has(previous.symbol)) continue;');
    expect(cache).toContain('quotes.push(previous)');
  });
});
