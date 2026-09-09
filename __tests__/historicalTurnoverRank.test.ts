import { computeTurnoverRankAsOfDate } from '@/lib/scanner/TurnoverRank';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';

jest.mock('@/lib/datasource/CandleStorageAdapter', () => ({ readCandleFile: jest.fn() }));

test('future volume cannot change the historical stock pool', async () => {
  const days = ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10'];
  jest.mocked(readCandleFile).mockImplementation(async (symbol) => ({
    symbol, lastDate: '2026-09-08', updatedAt: '',
    candles: [
      ...days.map(date => ({ date, open: 10, high: 10, low: 10, close: 10, volume: symbol === '1111.TW' ? 100 : 1 })),
      { date: '2026-09-08', open: 10, high: 10, low: 10, close: 10, volume: symbol === '2222.TW' ? 1_000_000 : 1 },
    ],
  }));
  const stocks = [{ symbol: '1111.TW' }, { symbol: '2222.TW' }];
  expect([...await computeTurnoverRankAsOfDate('TW', stocks, '2026-08-10', 1)]).toEqual([['1111.TW', 1]]);
  expect([...await computeTurnoverRankAsOfDate('TW', stocks, '2026-09-08', 1)]).toEqual([['2222.TW', 1]]);
});
