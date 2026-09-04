import { runQuoteEndToEndProbe } from '@/lib/health/quoteEndToEnd';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('端到端報價 invariant', () => {
  afterEach(() => jest.restoreAllMocks());

  test('持股、單股與 K 線都到同一預期日才算 healthy', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/api/portfolio/quotes')) {
        return jsonResponse({ quotes: [{ symbol: '3081.TWO', price: 3370, asOf: '2026-08-27', stale: false }] });
      }
      if (url.includes('/api/stock/quote')) {
        return jsonResponse({ date: '2026-08-27', close: 3370, stale: false });
      }
      if (url.includes('/api/realtime')) {
        return jsonResponse({ quotes: [{ symbol: '3081', price: 3370, date: '2026-08-27', stale: false }] });
      }
      return jsonResponse({ candles: [{ date: '2026-08-27', close: 3370 }] });
    });

    await expect(runQuoteEndToEndProbe({
      baseUrl: 'http://localhost:3000',
      symbols: ['3081.TWO'],
      expectedDate: '2026-08-27',
    })).resolves.toMatchObject({ ok: true, issues: [] });
  });

  test('任何一個使用者出口仍顯示昨日，都會直接報錯', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/api/portfolio/quotes')) {
        return jsonResponse({ quotes: [{ symbol: '3081.TWO', price: 3255, asOf: '2026-08-26', stale: true }] });
      }
      if (url.includes('/api/stock/quote')) {
        return jsonResponse({ date: '2026-08-27', close: 3370, stale: false });
      }
      if (url.includes('/api/realtime')) {
        return jsonResponse({ quotes: [{ symbol: '3081', price: 3370, date: '2026-08-27', stale: false }] });
      }
      return jsonResponse({ candles: [{ date: '2026-08-26', close: 3255 }] });
    });

    const result = await runQuoteEndToEndProbe({
      baseUrl: 'http://localhost:3000',
      symbols: ['3081.TWO'],
      expectedDate: '2026-08-27',
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: 'portfolio', symbol: '3081.TWO' }),
      expect.objectContaining({ surface: 'chart', symbol: '3081.TWO' }),
    ]));
  });

  test('日期相同但任一出口價格不同仍判定失敗，且健康檢查走使用者實際 local 圖表', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/api/portfolio/quotes')) {
        return jsonResponse({ quotes: [{ symbol: '3081.TWO', price: 3370, asOf: '2026-08-27', stale: false }] });
      }
      if (url.includes('/api/stock/quote')) {
        return jsonResponse({ date: '2026-08-27', close: 3500, stale: false });
      }
      if (url.includes('/api/realtime')) {
        return jsonResponse({ quotes: [{ symbol: '3081', price: 3370, date: '2026-08-27', stale: false }] });
      }
      return jsonResponse({ candles: [{ date: '2026-08-27', close: 3370 }] });
    });

    const result = await runQuoteEndToEndProbe({
      baseUrl: 'http://localhost:3000',
      symbols: ['3081.TWO'],
      expectedDate: '2026-08-27',
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: 'single', symbol: '3081.TWO' }),
    ]));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('&local=1'))).toBe(true);
  });

  test('官方確認零成交時，四個出口保留上一個真實交易日且一致標示 no-trade', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/api/portfolio/quotes')) {
        return jsonResponse({ quotes: [{
          symbol: '2064.TWO', price: 12.25, asOf: '2026-08-28',
          source: 'l1-no-trade', status: 'no-trade', stale: false,
        }] });
      }
      if (url.includes('/api/stock/quote')) {
        return jsonResponse({
          date: '2026-08-28', close: 12.25, source: 'l1-no-trade',
          status: 'no-trade', stale: false,
        });
      }
      if (url.includes('/api/realtime')) {
        return jsonResponse({ quotes: [{
          symbol: '2064', price: 12.25, date: '2026-08-28',
          source: 'l1-no-trade', status: 'no-trade', stale: false,
        }] });
      }
      return jsonResponse({
        candles: [{ date: '2026-08-28', close: 12.25 }],
        quoteStatus: 'no-trade',
      });
    });

    await expect(runQuoteEndToEndProbe({
      baseUrl: 'http://localhost:3000',
      symbols: ['2064.TWO'],
      expectedDate: '2026-08-31',
    })).resolves.toMatchObject({
      ok: true,
      issues: [],
      surfaces: { portfolio: true, single: true, chart: true, realtime: true },
    });
  });

  test('CN probe 不呼叫 TW-only realtime endpoint，並明確標成不適用', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/api/portfolio/quotes')) {
        return jsonResponse({ quotes: [{ symbol: '600519.SS', price: 1335.48, asOf: '2026-09-04', stale: false }] });
      }
      if (url.includes('/api/stock/quote')) {
        return jsonResponse({ date: '2026-09-04', close: 1335.48, stale: false });
      }
      return jsonResponse({ candles: [{ date: '2026-09-04', close: 1335.48 }] });
    });

    await expect(runQuoteEndToEndProbe({
      baseUrl: 'http://localhost:3000',
      symbols: ['600519.SS'],
      expectedDate: '2026-09-04',
      includeRealtime: false,
    })).resolves.toMatchObject({
      ok: true,
      issues: [],
      surfaces: { portfolio: true, single: true, chart: true, realtime: null },
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/realtime'))).toBe(false);
  });
});
