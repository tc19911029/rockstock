import { repairReadFailedSymbols } from '@/lib/datasource/eodReadFailureRepair';
import type { Candle } from '@/types';

const history = Array.from({ length: 30 }, (_, index): Candle => ({
  date: `2026-07-${String(index + 1).padStart(2, '0')}`,
  open: 70,
  high: 71,
  low: 69,
  close: 70,
  volume: 100,
}));

describe('EOD read failure auto-repair', () => {
  test('完整歷史重建後，以官方收盤值覆蓋目標日', async () => {
    const saveCandles = jest.fn().mockResolvedValue(undefined);
    const fetchCandles = jest.fn().mockResolvedValue(history);
    const official = { vendor: 'TPEx', open: 80, high: 80.5, low: 75.2, close: 75.5, volume: 4129 };

    const result = await repairReadFailedSymbols({
      market: 'TW',
      date: '2026-09-04',
      symbols: ['3718.TWO'],
      fetchCandles,
      officialQuotes: new Map([['3718.TWO', official]]),
      saveCandles,
    });

    expect(result).toEqual({ attempted: 1, repaired: 1, failed: [] });
    expect(fetchCandles).toHaveBeenCalledWith('3718.TWO', '2026-09-04');
    expect(saveCandles).toHaveBeenNthCalledWith(1, '3718.TWO', 'TW', history, { replaceExisting: true });
    expect(saveCandles).toHaveBeenNthCalledWith(2, '3718.TWO', 'TW', [{ date: '2026-09-04', ...official }], { trustedOfficial: true });
  });

  test('歷史不足 30 根時不覆寫既有壞檔', async () => {
    const saveCandles = jest.fn().mockResolvedValue(undefined);
    const result = await repairReadFailedSymbols({
      market: 'TW',
      date: '2026-09-04',
      symbols: ['9999.TWO'],
      fetchCandles: async () => history.slice(0, 2),
      officialQuotes: new Map(),
      saveCandles,
    });

    expect(result).toEqual({ attempted: 1, repaired: 0, failed: ['9999.TWO'] });
    expect(saveCandles).not.toHaveBeenCalled();
  });
});
