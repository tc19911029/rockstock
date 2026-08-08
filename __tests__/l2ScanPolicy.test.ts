import { canInjectL2ForScan, usableIntradaySnapshot } from '@/lib/scanner/l2ScanPolicy';

describe('L2 scan policy', () => {
  test('盤後掃描絕不注入 L2', () => {
    expect(canInjectL2ForScan('post_close')).toBe(false);
    expect(canInjectL2ForScan('intraday')).toBe(true);
  });

  test('盤中快照必須日期相符且 updatedAt 可解析', () => {
    const snapshot = {
      market: 'TW' as const,
      date: '2026-08-07',
      updatedAt: '2026-08-07T03:32:44.000Z',
      count: 1,
      quotes: [{
        symbol: '2330', name: '台積電', open: 1, high: 2, low: 1, close: 2,
        volume: 10, prevClose: 1, changePercent: 100,
      }],
    };
    expect(usableIntradaySnapshot(snapshot, '2026-08-07')).toBe(true);
    expect(usableIntradaySnapshot(snapshot, '2026-08-08')).toBe(false);
    expect(usableIntradaySnapshot({ ...snapshot, updatedAt: 'bad-date' }, '2026-08-07')).toBe(false);
  });
});
