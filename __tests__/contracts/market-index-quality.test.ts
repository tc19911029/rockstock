import {
  evaluateMarketIndexQuality,
  filterIncompleteMarketIndexCandles,
  isCompleteMarketIndexCandle,
  shouldRefreshMarketIndex,
} from '@/lib/datasource/marketIndexQuality';
import type { Candle } from '@/types';

const complete: Candle = {
  date: '2026-09-04',
  open: 45991.28,
  high: 46620.96,
  low: 45966.86,
  close: 46551.13,
  volume: 9_267_047,
};

describe('market index OHLCV quality', () => {
  test('完整價格但零成交量仍是不完整資料', () => {
    const zeroVolume = { ...complete, volume: 0 };
    expect(isCompleteMarketIndexCandle(zeroVolume)).toBe(false);
    expect(filterIncompleteMarketIndexCandles('^TWII', [zeroVolume])).toEqual([]);
    expect(filterIncompleteMarketIndexCandles('2330.TW', [zeroVolume])).toEqual([zeroVolume]);
  });

  test('日期已最新但成交量缺失時仍要求重抓', () => {
    const data = { lastDate: complete.date, candles: [{ ...complete, volume: 0 }] };
    expect(shouldRefreshMarketIndex('^TWII', data, complete.date)).toBe(true);
    expect(shouldRefreshMarketIndex('^TWII', { lastDate: complete.date, candles: [complete] }, complete.date)).toBe(false);
  });

  test('健康檢查會指出缺量原因', () => {
    const status = evaluateMarketIndexQuality(
      '^TWOII',
      { lastDate: complete.date, candles: [{ ...complete, volume: 0 }] },
      complete.date,
    );
    expect(status).toMatchObject({ complete: false, reason: 'missing-volume', volume: 0 });
  });
});
