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
        return jsonResponse({ quotes: [{ symbol: '3081.TWO', asOf: '2026-08-27', stale: false }] });
      }
      if (url.includes('/api/stock/quote')) {
        return jsonResponse({ date: '2026-08-27', stale: false });
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
        return jsonResponse({ quotes: [{ symbol: '3081.TWO', asOf: '2026-08-26', stale: true }] });
      }
      if (url.includes('/api/stock/quote')) {
        return jsonResponse({ date: '2026-08-27', stale: false });
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
});
