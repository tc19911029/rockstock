const readCandleFile = jest.fn();
const readIntradaySnapshot = jest.fn();
const getTWSESingleIntraday = jest.fn();
const getFugleQuote = jest.fn();
const getEastMoneySingleQuote = jest.fn();
const fetchQuote = jest.fn();

jest.mock('@/lib/datasource/CandleStorageAdapter', () => ({
  readCandleFile: (...args: unknown[]) => readCandleFile(...args),
}));
jest.mock('@/lib/datasource/marketHours', () => ({
  isMarketPollingWindow: () => false,
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

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/stock/quote/route';

describe('GET /api/stock/quote 休市防護', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readCandleFile.mockResolvedValue(null);
  });

  test('舊分頁輪詢台股指數時只讀 L1，不空打 MIS/Fugle/L2', async () => {
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
    expect(readIntradaySnapshot).not.toHaveBeenCalled();
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
});
