import { buildStockLoadHref, isSameStockSymbol } from '@/lib/navigation/stockUrl';

describe('stock URL canonicalization', () => {
  test('replaces a stale load value and removes the legacy symbol alias', () => {
    expect(buildStockLoadHref(
      '/',
      '?load=688981.SS&symbol=600519&tf=1d&tab=scan',
      '600519.SS',
      '1d',
    )).toBe('/?load=600519.SS&tf=1d&tab=scan');
  });

  test('clears an old replay date after an explicit new-stock search', () => {
    expect(buildStockLoadHref(
      '/',
      '?load=6770.TW&date=2026-07-01&tab=youtube',
      '2330.TW',
      '1wk',
    )).toBe('/?load=2330.TW&tab=youtube&tf=1wk');
  });

  test('matches bare and resolved tickers but keeps same-code exchanges distinct', () => {
    expect(isSameStockSymbol('600519', '600519.SS')).toBe(true);
    expect(isSameStockSymbol('2330', '2330.TW')).toBe(true);
    expect(isSameStockSymbol('000001.SS', '000001.SZ')).toBe(false);
  });
});
