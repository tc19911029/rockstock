jest.mock('@/lib/datasource/UnifiedRateLimiter', () => ({ rateLimiter: { acquire: jest.fn(), reportSuccess: jest.fn(), reportFailure: jest.fn() } }));
jest.mock('@/lib/datasource/MemoryCache', () => ({ globalCache: { get: jest.fn(), set: jest.fn() } }));
import { TencentHistProvider } from '@/lib/datasource/TencentHistProvider';
const original = global.fetch;
afterEach(() => { global.fetch = original; });
test('CN range uses unadjusted endpoint and ignores forward-adjusted rows', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: { sz300346: {
    day: [['2026-09-09','51.60','52.74','54.10','51.60','332458']],
    qfqday: [['2026-09-09','51.52','52.66','54.02','51.52','332458']],
  } } }) });
  const rows = await new TencentHistProvider().getCandlesRange('300346.SZ', '2026-09-09', '2026-09-09');
  expect(rows[0]).toMatchObject({ open: 51.6, close: 52.74, volume: 33245800 });
  expect((global.fetch as jest.Mock).mock.calls[0][0]).toMatch(/,10,$/);
});
test('range refuses adjusted-only response instead of silently contaminating L1', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: { sz300346: {
    qfqday: [['2026-09-09','51.52','52.66','54.02','51.52','332458']],
  } } }) });
  expect(await new TencentHistProvider().getCandlesRange('300346.SZ', '2026-09-09', '2026-09-09')).toEqual([]);
});
jest.mock('@/lib/datasource/MultiMarketProvider', () => ({ dataProvider: { getCandlesRange: jest.fn(), getHistoricalCandles: jest.fn() } }));
test('scanner persistence fetches the raw range instead of adjusted history', async () => {
  const { dataProvider } = await import('@/lib/datasource/MultiMarketProvider');
  (dataProvider.getCandlesRange as jest.Mock).mockResolvedValue([{ date: '2026-09-09', open: 51.6, high: 54.1, low: 51.6, close: 52.74, volume: 33245800 }]);
  const { ChinaScanner } = await import('@/lib/scanner/ChinaScanner');
  const rows = await new ChinaScanner().fetchCandles('300346.SZ', '2026-09-09');
  expect(dataProvider.getCandlesRange).toHaveBeenCalledWith('300346.SZ', '2024-09-09', '2026-09-09');
  expect(dataProvider.getHistoricalCandles).not.toHaveBeenCalled();
  expect(rows[0].close).toBe(52.74);
});
