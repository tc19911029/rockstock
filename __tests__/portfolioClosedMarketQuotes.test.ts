const readCandleFile = jest.fn();

jest.mock('@/lib/datasource/CandleStorageAdapter', () => ({
  readCandleFile: (...args: unknown[]) => readCandleFile(...args),
}));

import { buildFreshSnapshotFallback, fetchFinalL1Quotes } from '@/app/api/portfolio/quotes/route';

describe('休市持倉報價', () => {
  beforeEach(() => readCandleFile.mockReset());

  test('使用正式 L1 最後日 K，而不是盤中 L2 快照', async () => {
    readCandleFile.mockImplementation(async (symbol: string) => symbol === '6770.TW' ? {
      candles: [
        { date: '2026-08-13', close: 74.9 },
        { date: '2026-08-14', close: 78.4 },
      ],
    } : null);

    await expect(fetchFinalL1Quotes([
      { original: '6770', resolved: '6770.TWO', market: 'TW' },
    ], 'TW')).resolves.toEqual([
      { symbol: '6770', price: 78.4, changePercent: 4.67 },
    ]);

    expect(readCandleFile).toHaveBeenCalledWith('6770.TWO', 'TW');
    expect(readCandleFile).toHaveBeenCalledWith('6770.TW', 'TW');
  });

  test('陸股 L1 尚未定稿時，以通過收盤守門的 L2 補漲幅', () => {
    const quotes = buildFreshSnapshotFallback([
      { original: '002821.SZ', resolved: '002821.SZ', market: 'CN' },
    ], 'CN', {
      market: 'CN',
      date: '2026-08-20',
      updatedAt: '2026-08-20T07:47:17.256Z', // 上海 15:47
      count: 1,
      quotes: [{
        symbol: '002821', name: '凱萊英', open: 171, high: 184, low: 170,
        close: 182.4, volume: 123, prevClose: 170.59, changePercent: 6.92,
      }],
    }, new Date('2026-08-20T11:20:00.000Z'));

    expect(quotes).toEqual([{ symbol: '002821.SZ', name: '凱萊英', price: 182.4, changePercent: 6.92 }]);
  });

  test('陸股收盤前凍結的 L2 不得補進盤後報價', () => {
    const quotes = buildFreshSnapshotFallback([
      { original: '002821.SZ', resolved: '002821.SZ', market: 'CN' },
    ], 'CN', {
      market: 'CN',
      date: '2026-08-20',
      updatedAt: '2026-08-20T06:58:00.000Z', // 上海 14:58
      count: 1,
      quotes: [{
        symbol: '002821', name: '凱萊英', open: 171, high: 184, low: 170,
        close: 182.4, volume: 123, prevClose: 170.59, changePercent: 6.92,
      }],
    }, new Date('2026-08-20T11:20:00.000Z'));

    expect(quotes).toEqual([]);
  });
});
