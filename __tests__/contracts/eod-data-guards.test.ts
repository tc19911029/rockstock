import { rocDateToAd } from '@/lib/datasource/eodSettleBatch';
import { expectedTwSymbolFromEntries } from '@/lib/datasource/twSymbolMarket';
import { sanitizeOHLC } from '@/lib/datasource/CandleStorageAdapter';

describe('EOD data guards', () => {
  test.each([
    ['1150812', '2026-08-12'],
    ['115/08/12', '2026-08-12'],
  ])('TPEx ROC date %s parses as %s', (raw, expected) => {
    expect(rocDateToAd(raw)).toBe(expected);
  });

  test('stock master, not counterpart file existence, determines TW suffix', () => {
    const entries = [{ code: '5236', market: 'TWSE' as const }];
    expect(expectedTwSymbolFromEntries('5236.TW', entries)).toBe('5236.TW');
    expect(expectedTwSymbolFromEntries('5236.TWO', entries)).toBe('5236.TW');
  });

  test('out-of-range open is rejected instead of clipped to high', () => {
    const bars = sanitizeOHLC('002350.SZ', 'CN', [{
      date: '2026-08-12', open: 16.64, high: 15.4, low: 14.51, close: 15.26, volume: 21383509,
    }]);
    expect(bars).toEqual([]);
  });
});
