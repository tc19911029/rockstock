jest.mock('@/lib/datasource/TpexEmergingProvider', () => ({ resolveEmergingCompany: jest.fn(), fetchEmergingQuote: jest.fn() }));
jest.mock('@/lib/datasource/twSymbolMarket', () => ({ expectedTwSymbol: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/datasource/IntradayCache', () => ({ readIntradaySnapshot: jest.fn().mockResolvedValue(null) }));
jest.mock('@/lib/datasource/CandleStorageAdapter', () => ({ readCandleFile: jest.fn().mockResolvedValue(null) }));
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/portfolio/quotes/route';
import { resolveStockIdentity } from '@/lib/stocks/resolveStockIdentity';
import { resolveEmergingCompany, fetchEmergingQuote } from '@/lib/datasource/TpexEmergingProvider';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { fetchResolvedStockQuote } from '@/lib/stocks/fetchResolvedStockQuote';

beforeEach(() => {
  jest.mocked(resolveEmergingCompany).mockImplementation(async s => ({ code: s.split('.')[0], name: s.startsWith('7928') ? '合聖科技*' : '仁新*' }));
  jest.mocked(fetchEmergingQuote).mockResolvedValue({ date: '2026-09-07', open: 399, high: 410, low: 395, close: 399,
    volume: 63, previousClose: 400, changePercent: -0.25, priceBasis: 'esb-average', stale: false, source: 'tpex-esb', updatedAt: '2026-09-07T14:30:00+08:00' });
});

it('returns a named ESB quote using the original key and permits the add-position/watchlist resolver', async () => {
  const response = await GET(new NextRequest('http://localhost/api/portfolio/quotes?symbols=7928.TW,6696.TWO'));
  const body = await response.json();
  expect(body.missingSymbols).toEqual([]);
  expect(body.quotes[0]).toMatchObject({ symbol: '7928.TW', canonicalSymbol: '7928.TWO', name: '合聖科技*', price: 399, stale: false, priceKind: 'esb-average' });
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue(Response.json(body));
  try { await expect(fetchResolvedStockQuote('7928.TW')).resolves.toMatchObject({ canonicalSymbol: '7928.TWO', name: '合聖科技*', price: 399 }); }
  finally { global.fetch = originalFetch; }
  await expect(resolveStockIdentity({ symbol: '7928' })).resolves.toMatchObject({ canonicalSymbol: '7928.TWO', name: '合聖科技*' });
});

it('preserves stale and missing status instead of using a mainboard fallback', async () => {
  jest.mocked(fetchEmergingQuote).mockResolvedValueOnce(null);
  const response = await GET(new NextRequest('http://localhost/api/portfolio/quotes?symbols=7928.TWO'));
  expect((await response.json()).missingSymbols).toEqual(['7928.TWO']);
  expect(readIntradaySnapshot).not.toHaveBeenCalled();
  const fresh = await fetchEmergingQuote('6696');
  jest.mocked(fetchEmergingQuote).mockResolvedValue({ ...fresh!, stale: true });
  const stale = await GET(new NextRequest('http://localhost/api/portfolio/quotes?symbols=6696.TWO'));
  expect((await stale.json()).staleSymbols).toEqual(['6696.TWO']);
});
