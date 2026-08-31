import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = (relative: string) => readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('CN lunch-break quote contract', () => {
  test('中央 vendor 排程只看實際開盤，不在午休刷新全市場', () => {
    const scheduler = source('instrumentation.node.ts');
    const route = source('app/api/cron/update-intraday/route.ts');
    expect(scheduler).toContain("!isMarketOpen('CN') && !isPostCloseWindow('CN')");
    expect(route).toContain("isMarketOpen('CN') || isPostCloseWindow('CN')");
  });

  test('午休持倉、單股與走圖只讀中央 11:30 快照，不打單股 provider', () => {
    const portfolio = source('app/api/portfolio/quotes/route.ts');
    const quote = source('app/api/stock/quote/route.ts');
    const chart = source('app/api/stock/route.ts');
    const index = source('lib/datasource/IndexRealtime.ts');

    expect(portfolio).toContain('cnLunchBreak\n      ? readIntradaySnapshot');
    expect(quote).toContain('if (isCN && !cnLunchBreak)');
    expect(chart).toContain('isCN && !isCnIndex && !cnLunchBreak');
    expect(index).toContain('else if (!isCNMarketLunchBreak())');
  });

  test('題材頁午休顯示上午收盤價，並保留 timer 等 13:00 自動恢復', () => {
    const route = source('app/api/cn-sectors/live/route.ts');
    const view = source('components/sectors/LiveThemesView.tsx');
    expect(route).toContain('lunchBreak = isCNMarketLunchBreak()');
    expect(view).toContain('午間休市 · 上午收盤價');
    expect(view).toContain('if (!j.marketOpen && !j.lunchBreak) stop()');
  });
});
