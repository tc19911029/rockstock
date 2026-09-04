import { fetchLiveIndexQuote } from '@/lib/datasource/IndexRealtime';
import { fetchQuote } from '@/lib/cn-sanse/cnQuote';
import { readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';

jest.mock('@/lib/cn-sanse/cnQuote', () => ({ fetchQuote: jest.fn() }));
jest.mock('@/lib/datasource/IntradayCache', () => ({
  readIntradaySnapshot: jest.fn(),
}));
jest.mock('@/lib/datasource/intradayFreshness', () => ({ assessIntradayFreshness: jest.fn() }));

const tencentMock = fetchQuote as jest.MockedFunction<typeof fetchQuote>;
const snapshotMock = readIntradaySnapshot as jest.MockedFunction<typeof readIntradaySnapshot>;
const freshnessMock = assessIntradayFreshness as jest.MockedFunction<typeof assessIntradayFreshness>;

describe('大盤獨立即時報價鏈', () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    snapshotMock.mockResolvedValue(null);
    freshnessMock.mockReturnValue({ stale: false, ageSeconds: 30, reason: null });
  });

  test('TW 加權指數使用與個股相同的中央 L2', async () => {
    snapshotMock.mockResolvedValue({
      market: 'TW', date: '2026-08-25', updatedAt: '2026-08-25T02:47:30.000Z', count: 1,
      quotes: [{
        symbol: '^TWII', name: '發行量加權股價指數', open: 44728.36, high: 44728.36,
        low: 44234.17, close: 44288.64, volume: 4963963, prevClose: 44000, changePercent: 0.66,
      }],
    });

    const result = await fetchLiveIndexQuote('^TWII', '2026-08-25');

    expect(snapshotMock).toHaveBeenCalledWith('TW', '2026-08-25');
    expect(result).toMatchObject({ source: 'l2', close: 44288.64, date: '2026-08-25' });
  });

  test('櫃買指數也從中央 L2 取得', async () => {
    snapshotMock.mockResolvedValue({
      market: 'TW', date: '2026-08-25', updatedAt: '2026-08-25T02:47:30.000Z', count: 1,
      quotes: [{
        symbol: '^TWOII', name: '櫃買指數', open: 384.87, high: 384.87,
        low: 377.95, close: 377.96, volume: 952828, prevClose: 380, changePercent: -0.54,
      }],
    });

    await expect(fetchLiveIndexQuote('^TWOII', '2026-08-25')).resolves.toMatchObject({ source: 'l2', close: 377.96 });
  });

  test('上證指數直接使用 Tencent 完整後綴，不撞 000001.SZ 個股', async () => {
    // 固定在 A 股上午盤；若測試剛好於真實午休執行，production 會正確跳過 Tencent。
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-25T02:00:00.000Z'));
    tencentMock.mockResolvedValue({
      date: '2026-08-25', price: 3868.92, prevClose: 3882.01, open: 3863.37,
      high: 3884.27, low: 3850.86, change: -13.09, changePct: -0.34,
      amplitude: 0.86, volumeLots: 253318922, amount: 0, volumeRatio: 0,
      turnover: 0, peTTM: 0, totalCap: 0, floatCap: 0,
    });

    const result = await fetchLiveIndexQuote('000001.SS', '2026-08-25');

    expect(tencentMock).toHaveBeenCalledWith('000001.SS');
    expect(result).toMatchObject({ source: 'tencent', close: 3868.92 });
  });

  test('獨立來源失效時拒絕凍結 L2', async () => {
    snapshotMock.mockResolvedValue({
      market: 'TW', date: '2026-08-25', updatedAt: '2026-08-25T01:16:43.000Z', count: 1,
      quotes: [{ symbol: '^TWII', name: '加權', open: 1, high: 2, low: 1, close: 2, volume: 1, prevClose: 1, changePercent: 100 }],
    });
    freshnessMock.mockReturnValue({ stale: true, ageSeconds: 1200, reason: '盤中快照已 20 分鐘未更新' });

    await expect(fetchLiveIndexQuote('^TWII', '2026-08-25')).resolves.toBeNull();
  });
});
