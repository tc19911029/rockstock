import { useReplayStore } from '@/store/replayStore';

it('keeps scanDate for the background refresh and does not rebase a historical replay', async () => {
  const originalFetch = global.fetch;
  const requests: string[] = [];
  global.fetch = jest.fn(async input => {
    const url = String(input); requests.push(url);
    const historical = url.includes('scanDate=2026-08-19');
    return Response.json({ ticker: '6696.TWO', name: '仁新*', marketBoard: 'emerging', adjustmentStatus: 'adjusted', candles: [
      { date: '2026-08-19', open: historical ? 930.93 : 93.093, close: historical ? 930.93 : 93.093,
        high: historical ? 960 : 96, low: historical ? 877 : 87.7, volume: 1859, priceBasis: 'esb-average' },
    ] });
  });
  try {
    await useReplayStore.getState().loadStock('6696.TWO', '1d', '1mo', '2026-08-19');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    expect(requests.every(url => url.includes('scanDate=2026-08-19'))).toBe(true);
    expect(useReplayStore.getState().allCandles[0].close).toBe(930.93);
    expect(useReplayStore.getState().isPolling).toBe(false);
  } finally { useReplayStore.getState().stopPolling(); global.fetch = originalFetch; }
});
