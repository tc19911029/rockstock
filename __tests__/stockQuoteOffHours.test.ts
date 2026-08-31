const readCandleFile = jest.fn();
const readIntradaySnapshot = jest.fn();
const getTWSESingleIntraday = jest.fn();
const getFugleQuote = jest.fn();
const getEastMoneySingleQuote = jest.fn();
const fetchQuote = jest.fn();
const fetchTaifexTxFuturesQuote = jest.fn();

jest.mock('@/lib/datasource/CandleStorageAdapter', () => ({
  readCandleFile: (...args: unknown[]) => readCandleFile(...args),
}));
jest.mock('@/lib/datasource/marketHours', () => ({
  isMarketPollingWindow: () => false,
  isAfterMarketClose: () => true,
  isMarketOpen: () => false,
  getQuoteSnapshotDate: () => '2026-08-26',
}));
jest.mock('@/lib/datasource/IntradayCache', () => ({
  readIntradaySnapshot: (...args: unknown[]) => readIntradaySnapshot(...args),
}));
jest.mock('@/lib/datasource/TWSERealtime', () => ({
  getTWSESingleIntraday: (...args: unknown[]) => getTWSESingleIntraday(...args),
}));
jest.mock('@/lib/datasource/FugleProvider', () => ({
  isFugleAvailable: () => true,
  getFugleQuote: (...args: unknown[]) => getFugleQuote(...args),
}));
jest.mock('@/lib/datasource/EastMoneyRealtime', () => ({
  getEastMoneySingleQuote: (...args: unknown[]) => getEastMoneySingleQuote(...args),
}));
jest.mock('@/lib/cn-sanse/cnQuote', () => ({
  fetchQuote: (...args: unknown[]) => fetchQuote(...args),
}));
jest.mock('@/lib/datasource/TaifexFuturesProvider', () => ({
  fetchTaifexTxFuturesQuote: (...args: unknown[]) => fetchTaifexTxFuturesQuote(...args),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/stock/quote/route';

describe('GET /api/stock/quote 休市防護', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-26T08:00:00.000Z'));
    jest.clearAllMocks();
    readCandleFile.mockResolvedValue(null);
    readIntradaySnapshot.mockResolvedValue(null);
    getTWSESingleIntraday.mockResolvedValue(null);
    fetchTaifexTxFuturesQuote.mockResolvedValue(null);
  });

  afterEach(() => jest.useRealTimers());

  test('舊分頁輪詢台股指數時先看中央 L2，沒有才回 L1，且不空打 MIS/Fugle', async () => {
    readCandleFile.mockResolvedValue({
      candles: [{ date: '2026-08-14', open: 24180, high: 24320, low: 24100, close: 24260, volume: 4_321_000 }],
    });

    const response = await GET(new NextRequest('http://localhost/api/stock/quote?symbol=%5ETWII'));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      symbol: '^TWII',
      date: '2026-08-14',
      close: 24260,
    });
    expect(readCandleFile).toHaveBeenCalledWith('^TWII', 'TW');
    expect(readIntradaySnapshot).toHaveBeenCalledTimes(1);
    expect(getTWSESingleIntraday).not.toHaveBeenCalled();
    expect(getFugleQuote).not.toHaveBeenCalled();
  });

  test('無後綴台股會嘗試上市與上櫃 L1 檔，找到後立即回傳', async () => {
    readCandleFile.mockImplementation(async (symbol: string) => symbol === '6770.TW' ? {
      candles: [{ date: '2026-08-14', open: 76.6, high: 81.8, low: 76.3, close: 78.4, volume: 527_933 }],
    } : null);

    const response = await GET(new NextRequest('http://localhost/api/stock/quote?symbol=6770'));

    await expect(response.json()).resolves.toMatchObject({ ok: true, symbol: '6770', date: '2026-08-14', close: 78.4 });
    expect(readCandleFile).toHaveBeenCalledWith('6770.TW', 'TW');
    expect(getEastMoneySingleQuote).not.toHaveBeenCalled();
    expect(fetchQuote).not.toHaveBeenCalled();
  });

  test('TXF 直接回傳期交所盤中近月 quote，不進股票 provider', async () => {
    fetchTaifexTxFuturesQuote.mockResolvedValue({
      date: '2026-08-25',
      open: 44658,
      high: 44800,
      low: 44533,
      close: 44782,
      volume: 4703,
      session: 'after-hours',
      quoteTime: '170435',
    });

    const response = await GET(new NextRequest('http://localhost/api/stock/quote?symbol=TXF'));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      symbol: 'TXF',
      date: '2026-08-25',
      close: 44782,
      session: 'after-hours',
    });
    expect(fetchTaifexTxFuturesQuote).toHaveBeenCalledTimes(1);
    expect(readCandleFile).not.toHaveBeenCalled();
    expect(getTWSESingleIntraday).not.toHaveBeenCalled();
    expect(getFugleQuote).not.toHaveBeenCalled();
  });

  test('正式 L1 尚未封存時，以收盤 L2 暫時顯示但不冒充官方收盤價', async () => {
    readCandleFile.mockResolvedValue({
      candles: [{ date: '2026-08-25', open: 2860, high: 2995, low: 2840, close: 2960, volume: 6075 }],
    });
    readIntradaySnapshot.mockResolvedValue({
      market: 'TW',
      date: '2026-08-26',
      updatedAt: '2026-08-26T06:35:00.000Z',
      count: 1,
      quotes: [{
        symbol: '3081', name: '聯亞', open: 3010, high: 3255, low: 2940, close: 3255,
        volume: 7470, prevClose: 2960, changePercent: 9.97, isActualTrade: true,
      }],
    });

    const response = await GET(new NextRequest('http://localhost/api/stock/quote?symbol=3081.TWO'));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      symbol: '3081.TWO',
      date: '2026-08-26',
      close: 3255,
      source: 'l2-provisional-close',
      status: 'provisional-close',
      provisional: true,
      stale: false,
    });
    expect(readIntradaySnapshot).toHaveBeenCalledTimes(1);
  });

  test('正式 L1 尚未封存時，不以同日 MIS 最後成交價補盤後盲區', async () => {
    readCandleFile.mockResolvedValue({
      candles: [{ date: '2026-08-25', open: 2860, high: 2995, low: 2840, close: 2960, volume: 6075 }],
    });
    getTWSESingleIntraday.mockResolvedValue({
      code: '3081', name: '聯亞', date: '2026-08-26', open: 3010, high: 3255,
      low: 2940, close: 3255, volume: 7470, previousClose: 2960,
      updatedAt: '2026-08-26T05:30:00.000Z',
    });

    const response = await GET(new NextRequest('http://localhost/api/stock/quote?symbol=3081.TWO'));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      symbol: '3081.TWO',
      date: '2026-08-25',
      close: 2960,
      source: 'l1',
      stale: true,
    });
    expect(readIntradaySnapshot).toHaveBeenCalledTimes(1);
    expect(getTWSESingleIntraday).not.toHaveBeenCalled();
  });

  test('MIS 回傳前一交易日殘值時拒絕補成今日價', async () => {
    readCandleFile.mockResolvedValue({
      candles: [{ date: '2026-08-25', open: 2860, high: 2995, low: 2840, close: 2960, volume: 6075 }],
    });
    getTWSESingleIntraday.mockResolvedValue({
      code: '3081', name: '聯亞', date: '2026-08-25', open: 2860, high: 2995,
      low: 2840, close: 2960, volume: 6075, previousClose: 2800,
    });

    const response = await GET(new NextRequest('http://localhost/api/stock/quote?symbol=3081.TWO'));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      date: '2026-08-25',
      close: 2960,
      source: 'l1',
      stale: true,
    });
  });

  test('連續無成交後的委託簿推估價只作暫定收盤顯示，不寫成官方 L1', async () => {
    readCandleFile.mockResolvedValue({
      candles: [{ date: '2026-08-25', open: 2860, high: 2995, low: 2840, close: 2960, volume: 6075 }],
    });
    readIntradaySnapshot.mockResolvedValue({
      market: 'TW',
      date: '2026-08-26',
      updatedAt: '2026-08-26T06:35:00.000Z',
      count: 1,
      quotes: [{
        symbol: '3081', name: '聯亞', open: 3010, high: 3255, low: 2940, close: 3255,
        volume: 0, prevClose: 2960, changePercent: 9.97, isActualTrade: false,
        priceKind: 'indicative',
      }],
    });

    const response = await GET(new NextRequest('http://localhost/api/stock/quote?symbol=3081.TWO'));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      date: '2026-08-26',
      close: 3255,
      source: 'l2-provisional-close',
      status: 'provisional-close',
      priceKind: 'indicative',
      provisional: true,
      stale: false,
    });
  });

  test('L1 已有今日資料時直接回傳，不再讀 L2', async () => {
    readCandleFile.mockResolvedValue({
      candles: [{ date: '2026-08-26', open: 3010, high: 3255, low: 2940, close: 3255, volume: 7470 }],
    });

    const response = await GET(new NextRequest('http://localhost/api/stock/quote?symbol=3081.TWO'));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      date: '2026-08-26',
      close: 3255,
      source: 'l1',
      stale: false,
    });
    expect(readIntradaySnapshot).not.toHaveBeenCalled();
  });
});
