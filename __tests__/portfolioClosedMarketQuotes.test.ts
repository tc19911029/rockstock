const readCandleFile = jest.fn();
const expectedTwSymbol = jest.fn();
const getTWChineseName = jest.fn();
const getCNChineseName = jest.fn();

jest.mock('@/lib/datasource/CandleStorageAdapter', () => ({
  readCandleFile: (...args: unknown[]) => readCandleFile(...args),
}));

jest.mock('@/lib/datasource/twSymbolMarket', () => ({
  expectedTwSymbol: (...args: unknown[]) => expectedTwSymbol(...args),
}));

jest.mock('@/lib/datasource/TWSENames', () => ({
  getTWChineseName: (...args: unknown[]) => getTWChineseName(...args),
  getCNChineseName: (...args: unknown[]) => getCNChineseName(...args),
}));

import { buildFreshSnapshotFallback, enrichQuoteNames, fetchFinalL1Quotes, resolveQuoteEntries } from '@/app/api/portfolio/quotes/route';

describe('休市持倉報價', () => {
  beforeEach(() => {
    readCandleFile.mockReset();
    expectedTwSymbol.mockReset();
    getTWChineseName.mockReset();
    getCNChineseName.mockReset();
    expectedTwSymbol.mockResolvedValue(null);
    getTWChineseName.mockResolvedValue(null);
    getCNChineseName.mockResolvedValue(null);
  });

  test('以股票主檔校正上市／上櫃後綴，同時保留原始請求 key', async () => {
    expectedTwSymbol.mockImplementation(async (symbol: string) => {
      if (symbol.startsWith('3081.')) return '3081.TWO';
      if (symbol.startsWith('2330.')) return '2330.TW';
      return null;
    });

    await expect(resolveQuoteEntries(['3081.TW', '2330', '002821.SZ'])).resolves.toEqual([
      { original: '3081.TW', resolved: '3081.TWO', market: 'TW' },
      { original: '2330', resolved: '2330.TW', market: 'TW' },
      { original: '002821.SZ', resolved: '002821.SZ', market: 'CN' },
    ]);
  });

  test('使用正式 L1 最後日 K，而不是盤中 L2 快照', async () => {
    readCandleFile.mockImplementation(async (symbol: string) => symbol === '6770.TW' ? {
      candles: [
        { date: '2026-08-13', close: 74.9 },
        { date: '2026-08-14', close: 78.4 },
      ],
    } : null);
    getTWChineseName.mockResolvedValue('力積電');

    await expect(fetchFinalL1Quotes([
      { original: '6770', resolved: '6770.TWO', market: 'TW' },
    ], 'TW')).resolves.toEqual([
      { symbol: '6770', canonicalSymbol: '6770.TW', name: '力積電', price: 78.4, changePercent: 4.67 },
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

    expect(quotes).toEqual([{ symbol: '002821.SZ', canonicalSymbol: '002821.SZ', name: '凱萊英', price: 182.4, changePercent: 6.92 }]);
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

  test('任何行情來源回 name=代號，都由最後出口補成正式中文名稱', async () => {
    getTWChineseName.mockResolvedValue('聯亞');
    await expect(enrichQuoteNames([
      { symbol: '3081.TW', canonicalSymbol: '3081.TWO', name: '3081', price: 2920, changePercent: 5.04 },
    ], [
      { original: '3081.TW', resolved: '3081.TWO', market: 'TW' },
    ])).resolves.toEqual([
      { symbol: '3081.TW', canonicalSymbol: '3081.TWO', name: '聯亞', price: 2920, changePercent: 5.04 },
    ]);
  });
});
