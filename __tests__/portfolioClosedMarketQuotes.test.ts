const readCandleFile = jest.fn();
const expectedTwSymbol = jest.fn();
const getTWChineseName = jest.fn();
const getCNChineseName = jest.fn();
const getTWSESingleIntraday = jest.fn();
const readIntradaySnapshot = jest.fn();
const readTWOfficialCloseState = jest.fn();

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

jest.mock('@/lib/datasource/TWSERealtime', () => ({
  getTWSESingleIntraday: (...args: unknown[]) => getTWSESingleIntraday(...args),
  resolveMisTradePrice: jest.fn(),
  parseMisPrice: jest.fn(),
}));

jest.mock('@/lib/datasource/IntradayCache', () => ({
  readIntradaySnapshot: (...args: unknown[]) => readIntradaySnapshot(...args),
}));

jest.mock('@/lib/datasource/twOfficialCloseState', () => ({
  readTWOfficialCloseState: (...args: unknown[]) => readTWOfficialCloseState(...args),
}));

import { buildFreshSnapshotFallback, enrichQuoteNames, fetchFinalL1Quotes, fetchSameDayTWCloseQuotes, fetchTWDisplayQuotes, resolveQuoteEntries } from '@/app/api/portfolio/quotes/route';

describe('休市持倉報價', () => {
  beforeEach(() => {
    readCandleFile.mockReset();
    expectedTwSymbol.mockReset();
    getTWChineseName.mockReset();
    getCNChineseName.mockReset();
    getTWSESingleIntraday.mockReset();
    readIntradaySnapshot.mockReset();
    readTWOfficialCloseState.mockReset();
    expectedTwSymbol.mockResolvedValue(null);
    getTWChineseName.mockResolvedValue(null);
    getCNChineseName.mockResolvedValue(null);
    readIntradaySnapshot.mockResolvedValue(null);
    readTWOfficialCloseState.mockResolvedValue(null);
  });

  test('同交易日盤後不以 MIS 冒充正式收盤價', async () => {
    getTWSESingleIntraday.mockResolvedValue({
      code: '3081', name: '聯亞', date: '2026-08-26', open: 3010, high: 3255,
      low: 2940, close: 3255, volume: 7470, previousClose: 2960,
    });

    await expect(fetchSameDayTWCloseQuotes([
      { original: '3081.TW', resolved: '3081.TWO', market: 'TW' },
    ], new Date('2026-08-26T08:00:00.000Z'))).resolves.toEqual([]);
    expect(getTWSESingleIntraday).not.toHaveBeenCalled();
  });

  test('盤後 MIS 日期不是今天時不覆蓋正式 L1', async () => {
    getTWSESingleIntraday.mockResolvedValue({
      code: '3081', name: '聯亞', date: '2026-08-25', open: 2860, high: 2995,
      low: 2840, close: 2960, volume: 6075, previousClose: 2800,
    });

    await expect(fetchSameDayTWCloseQuotes([
      { original: '3081.TW', resolved: '3081.TWO', market: 'TW' },
    ], new Date('2026-08-26T08:00:00.000Z'))).resolves.toEqual([]);
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
      {
        symbol: '6770', canonicalSymbol: '6770.TW', name: '力積電', price: 78.4, changePercent: 4.67,
        asOf: '2026-08-14', source: 'l1',
      },
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

    expect(quotes).toEqual([{
      symbol: '002821.SZ', canonicalSymbol: '002821.SZ', name: '凱萊英', price: 182.4, changePercent: 6.92,
      asOf: '2026-08-20', source: 'l2', stale: false, status: 'final', updatedAt: '2026-08-20T07:47:17.256Z',
    }]);
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

  test('台股收盤後官方 L1 未到時，L2 只作暫定收盤顯示', () => {
    const quotes = buildFreshSnapshotFallback([
      { original: '3081.TWO', resolved: '3081.TWO', market: 'TW' },
    ], 'TW', {
      market: 'TW',
      date: '2026-08-26',
      updatedAt: '2026-08-26T05:35:20.000Z',
      count: 1,
      quotes: [{
        symbol: '3081', name: '聯亞', open: 3010, high: 3255, low: 2940,
        close: 3255, volume: 7470, prevClose: 2960, changePercent: 9.97,
        priceKind: 'last_actual', isActualTrade: true,
      }],
    }, new Date('2026-08-26T05:40:00.000Z'));

    expect(quotes).toEqual([expect.objectContaining({
      symbol: '3081.TWO',
      price: 3255,
      asOf: '2026-08-26',
      source: 'l2-provisional-close',
      status: 'provisional-close',
      provisional: true,
      stale: false,
      marketSession: 'post_close_pending_official',
    })]);
  });

  test('同日官方 L1 優先；只有仍停在昨日的股票才由 L2 暫時補上', async () => {
    readCandleFile.mockImplementation(async (symbol: string) => {
      if (symbol.startsWith('2330.')) return {
        candles: [
          { date: '2026-08-25', close: 1200 },
          { date: '2026-08-26', close: 1210 },
        ],
      };
      if (symbol.startsWith('3081.')) return {
        candles: [
          { date: '2026-08-25', close: 2960 },
        ],
      };
      return null;
    });
    readIntradaySnapshot.mockResolvedValue({
      market: 'TW',
      date: '2026-08-26',
      updatedAt: '2026-08-26T05:35:20.000Z',
      count: 2,
      quotes: [
        { symbol: '2330', name: '台積電', open: 1205, high: 1215, low: 1200, close: 1211, volume: 1, prevClose: 1200, changePercent: 0.92, priceKind: 'last_actual' },
        { symbol: '3081', name: '聯亞', open: 3010, high: 3255, low: 2940, close: 3255, volume: 7470, prevClose: 2960, changePercent: 9.97, priceKind: 'last_actual' },
      ],
    });

    const quotes = await fetchTWDisplayQuotes([
      { original: '2330.TW', resolved: '2330.TW', market: 'TW' },
      { original: '3081.TWO', resolved: '3081.TWO', market: 'TW' },
    ], new Date('2026-08-26T05:40:00.000Z'));

    expect(quotes).toEqual([
      expect.objectContaining({ symbol: '2330.TW', price: 1210, asOf: '2026-08-26', source: 'l1' }),
      expect.objectContaining({ symbol: '3081.TWO', price: 3255, asOf: '2026-08-26', source: 'l2-provisional-close', provisional: true }),
    ]);
  });

  test('官方完整收盤表確認今日無成交後，保留上一筆真實 L1 並停用 L2 推估價', async () => {
    readCandleFile.mockImplementation(async (symbol: string) => symbol.startsWith('2064.') ? {
      candles: [
        { date: '2026-08-27', close: 12.1 },
        { date: '2026-08-28', close: 12.25 },
      ],
    } : null);
    readTWOfficialCloseState.mockResolvedValue({
      market: 'TW',
      date: '2026-08-31',
      settledAt: '2026-08-31T06:52:37.539Z',
      twseRows: 1364,
      tpexRows: 981,
      noTradeSymbols: ['2064'],
    });
    readIntradaySnapshot.mockResolvedValue({
      market: 'TW',
      date: '2026-08-31',
      updatedAt: '2026-08-31T05:35:20.000Z',
      count: 1,
      quotes: [{
        symbol: '2064', name: '晉椿', open: 12.2, high: 12.2, low: 12.2,
        close: 12.2, volume: 0, prevClose: 12.25, changePercent: -0.41,
        priceKind: 'indicative', isActualTrade: false,
      }],
    });

    await expect(fetchTWDisplayQuotes([
      { original: '2064.TWO', resolved: '2064.TWO', market: 'TW' },
    ], new Date('2026-08-31T07:00:00.000Z'))).resolves.toEqual([
      expect.objectContaining({
        symbol: '2064.TWO',
        price: 12.25,
        asOf: '2026-08-28',
        source: 'l1-no-trade',
        status: 'no-trade',
        provisional: false,
        stale: false,
      }),
    ]);
    expect(readIntradaySnapshot).not.toHaveBeenCalled();
  });

  test('陸股午休顯示 11:30 上午收盤快照，不標示為 stale', () => {
    const quotes = buildFreshSnapshotFallback([
      { original: '002821.SZ', resolved: '002821.SZ', market: 'CN' },
    ], 'CN', {
      market: 'CN',
      date: '2026-08-20',
      updatedAt: '2026-08-20T03:30:12.000Z', // 上海 11:30
      count: 1,
      quotes: [{
        symbol: '002821', name: '凱萊英', open: 171, high: 184, low: 170,
        close: 182.4, volume: 123, prevClose: 170.59, changePercent: 6.92,
      }],
    }, new Date('2026-08-20T04:20:00.000Z')); // 上海 12:20

    expect(quotes).toEqual([expect.objectContaining({
      symbol: '002821.SZ',
      price: 182.4,
      stale: false,
      status: 'final',
      marketSession: 'lunch_break',
    })]);
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
