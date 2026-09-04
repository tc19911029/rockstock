import { parseTPExDatedCloseResponse, rocDateToAd } from '@/lib/datasource/eodSettleBatch';
import { expectedTwSymbolFromEntries } from '@/lib/datasource/twSymbolMarket';
import {
  sanitizeOHLC,
  shouldBlockSingleCandleInitialization,
} from '@/lib/datasource/CandleStorageAdapter';

describe('EOD data guards', () => {
  test.each([
    ['1150812', '2026-08-12'],
    ['115/08/12', '2026-08-12'],
  ])('TPEx ROC date %s parses as %s', (raw, expected) => {
    expect(rocDateToAd(raw)).toBe(expected);
  });

  test('TPEx 指定日期官方表可在 latest feed 落後時提供完整 OHLCV', () => {
    const rows = Array.from({ length: 1014 }, (_, index) => [
      String(3000 + index), `股票${index}`, '52.5', '+1.0', '50', '53', '49.5', '1,234,000',
    ]);
    const parsed = parseTPExDatedCloseResponse({
      stat: 'ok',
      tables: [{
        date: '115/08/31',
        fields: ['代號', '名稱', '收盤 ', '漲跌', '開盤 ', '最高 ', '最低', '成交股數  '],
        data: rows,
      }],
    }, '2026-08-31');

    expect(parsed.size).toBe(1014);
    expect(parsed.get('3000')).toEqual({ open: 50, high: 53, low: 49.5, close: 52.5, volume: 1234 });
    expect(parseTPExDatedCloseResponse({ tables: [{ date: '115/08/28', fields: [], data: rows }] }, '2026-08-31').size).toBe(0);
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

  test('單根官方 K 可建立真正不存在的新股檔，但不得截斷讀壞的既有檔', () => {
    expect(shouldBlockSingleCandleInitialization(null, false, 1)).toBe(false);
    expect(shouldBlockSingleCandleInitialization(null, true, 1)).toBe(true);
    expect(shouldBlockSingleCandleInitialization(null, true, 2)).toBe(false);
  });
});
