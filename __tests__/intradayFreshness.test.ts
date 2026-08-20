import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';

describe('assessIntradayFreshness', () => {
  test('盤中同日但超過 6 分鐘未更新會判 stale', () => {
    const result = assessIntradayFreshness('TW', {
      date: '2026-08-20',
      updatedAt: '2026-08-20T02:11:00.000Z', // 台北 10:11
      count: 2097,
    }, new Date('2026-08-20T02:30:00.000Z'));
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/19 分鐘未更新/);
  });

  test('盤後拒絕日期正確但停在早盤的快照', () => {
    const result = assessIntradayFreshness('TW', {
      date: '2026-08-20',
      updatedAt: '2026-08-20T02:11:54.411Z',
      count: 2097,
    }, new Date('2026-08-20T10:22:00.000Z'));
    expect(result).toMatchObject({ stale: true, reason: '今日快照停在收盤 13:30 以前' });
  });

  test('盤後 13:30 後的最終快照視為 fresh', () => {
    const result = assessIntradayFreshness('TW', {
      date: '2026-08-20',
      updatedAt: '2026-08-20T05:31:00.000Z', // 台北 13:31
      count: 2097,
    }, new Date('2026-08-20T10:22:00.000Z'));
    expect(result).toMatchObject({ stale: false, reason: null });
  });

  test('資料日不是今天會判 stale', () => {
    const result = assessIntradayFreshness('TW', {
      date: '2026-08-19',
      updatedAt: '2026-08-19T05:31:00.000Z',
      count: 2097,
    }, new Date('2026-08-20T02:00:00.000Z'));
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/不是今天/);
  });
});
