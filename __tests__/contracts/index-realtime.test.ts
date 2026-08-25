import { fetchLiveIndexQuote } from '@/lib/datasource/IndexRealtime';
import { getFugleQuote } from '@/lib/datasource/FugleProvider';
import { fetchQuote } from '@/lib/cn-sanse/cnQuote';
import { fetchTWIndexQuote, readIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';

jest.mock('@/lib/datasource/FugleProvider', () => ({
  isFugleAvailable: jest.fn(() => true),
  getFugleQuote: jest.fn(),
}));
jest.mock('@/lib/cn-sanse/cnQuote', () => ({ fetchQuote: jest.fn() }));
jest.mock('@/lib/datasource/IntradayCache', () => ({
  fetchTWIndexQuote: jest.fn(),
  readIntradaySnapshot: jest.fn(),
}));
jest.mock('@/lib/datasource/intradayFreshness', () => ({ assessIntradayFreshness: jest.fn() }));

const fugleMock = getFugleQuote as jest.MockedFunction<typeof getFugleQuote>;
const tencentMock = fetchQuote as jest.MockedFunction<typeof fetchQuote>;
const misMock = fetchTWIndexQuote as jest.MockedFunction<typeof fetchTWIndexQuote>;
const snapshotMock = readIntradaySnapshot as jest.MockedFunction<typeof readIntradaySnapshot>;
const freshnessMock = assessIntradayFreshness as jest.MockedFunction<typeof assessIntradayFreshness>;

describe('大盤獨立即時報價鏈', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    snapshotMock.mockResolvedValue(null);
    misMock.mockResolvedValue(null);
  });

  test('TW 加權指數優先使用 Fugle IX0001，不先吃 L2', async () => {
    fugleMock.mockResolvedValue({
      code: 'IX0001', name: '發行量加權股價指數', date: '2026-08-25',
      open: 44728.36, high: 44728.36, low: 44234.17, close: 44288.64, volume: 4963963,
      updatedAt: '2026-08-25T02:47:30.000Z',
    });

    const result = await fetchLiveIndexQuote('^TWII', '2026-08-25');

    expect(fugleMock).toHaveBeenCalledWith('IX0001');
    expect(result).toMatchObject({ source: 'fugle', close: 44288.64, date: '2026-08-25' });
    expect(misMock).not.toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  test('櫃買指數使用 Fugle IX0043', async () => {
    fugleMock.mockResolvedValue({
      code: 'IX0043', name: '櫃買指數', date: '2026-08-25',
      open: 384.87, high: 384.87, low: 377.95, close: 377.96, volume: 952828,
    });

    await fetchLiveIndexQuote('^TWOII', '2026-08-25');
    expect(fugleMock).toHaveBeenCalledWith('IX0043');
  });

  test('上證指數直接使用 Tencent 完整後綴，不撞 000001.SZ 個股', async () => {
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
    fugleMock.mockResolvedValue(null);
    snapshotMock.mockResolvedValue({
      market: 'TW', date: '2026-08-25', updatedAt: '2026-08-25T01:16:43.000Z', count: 1,
      quotes: [{ symbol: '^TWII', name: '加權', open: 1, high: 2, low: 1, close: 2, volume: 1, prevClose: 1, changePercent: 100 }],
    });
    freshnessMock.mockReturnValue({ stale: true, ageSeconds: 1200, reason: '盤中快照已 20 分鐘未更新' });

    await expect(fetchLiveIndexQuote('^TWII', '2026-08-25')).resolves.toBeNull();
  });
});
