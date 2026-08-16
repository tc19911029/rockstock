const readCandleFile = jest.fn();

jest.mock('@/lib/datasource/CandleStorageAdapter', () => ({
  readCandleFile: (...args: unknown[]) => readCandleFile(...args),
}));

import { fetchFinalL1Quotes } from '@/app/api/portfolio/quotes/route';

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
});
