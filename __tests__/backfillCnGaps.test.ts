import { fetchCandlesContainingTarget } from '@/lib/datasource/fetchCandlesContainingTarget';

const bar = (date: string) => ({ date, open: 10, high: 11, low: 9, close: 10, volume: 100 });

describe('fetchCandlesContainingTarget', () => {
  it('uses a narrow range when a provider long window stops before target date', async () => {
    const first = {
      getHistoricalCandles: jest.fn(async () => [bar('2026-08-12')]),
      getCandlesRange: jest.fn(async () => [bar('2026-08-12'), bar('2026-08-13')]),
    };
    const fallback = { getHistoricalCandles: jest.fn(async () => []) };

    const candles = await fetchCandlesContainingTarget('601857.SS', '2026-08-13', [first, fallback]);

    expect(candles?.at(-1)?.date).toBe('2026-08-13');
    expect(first.getCandlesRange).toHaveBeenCalledWith('601857.SS', '2026-08-10', '2026-08-13');
    expect(fallback.getHistoricalCandles).not.toHaveBeenCalled();
  });

  it('falls through when both windows from the first provider miss target date', async () => {
    const first = {
      getHistoricalCandles: jest.fn(async () => [bar('2026-08-12')]),
      getCandlesRange: jest.fn(async () => [bar('2026-08-12')]),
    };
    const fallback = { getHistoricalCandles: jest.fn(async () => [bar('2026-08-13')]) };

    const candles = await fetchCandlesContainingTarget('601857.SS', '2026-08-13', [first, fallback]);

    expect(candles?.at(-1)?.date).toBe('2026-08-13');
    expect(fallback.getHistoricalCandles).toHaveBeenCalled();
  });
});
