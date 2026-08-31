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

  test('陸股盤後 15:00 後的板塊快照視為 fresh', () => {
    const result = assessIntradayFreshness('CN', {
      date: '2026-08-20',
      updatedAt: '2026-08-20T08:30:07.949Z', // 上海 16:30
      count: 1000,
    }, new Date('2026-08-20T11:20:00.000Z'));
    expect(result).toMatchObject({ stale: false, reason: null });
  });

  test('陸股盤後拒絕停在 15:00 以前的板塊快照', () => {
    const result = assessIntradayFreshness('CN', {
      date: '2026-08-20',
      updatedAt: '2026-08-20T06:58:00.000Z', // 上海 14:58
      count: 1000,
    }, new Date('2026-08-20T11:20:00.000Z'));
    expect(result).toMatchObject({ stale: true, reason: '今日快照停在收盤 15:00 以前' });
  });

  test('陸股午休沿用上午 11:30 快照，不因超過 6 分鐘誤判 stale', () => {
    const result = assessIntradayFreshness('CN', {
      date: '2026-08-20',
      updatedAt: '2026-08-20T03:30:15.000Z', // 上海 11:30
      count: 3062,
    }, new Date('2026-08-20T04:35:00.000Z')); // 上海 12:35
    expect(result).toMatchObject({ stale: false, reason: null });
  });

  test('陸股午休拒絕未抓到 11:30 上午收盤的舊快照', () => {
    const result = assessIntradayFreshness('CN', {
      date: '2026-08-20',
      updatedAt: '2026-08-20T03:20:00.000Z', // 上海 11:20
      count: 3062,
    }, new Date('2026-08-20T04:35:00.000Z'));
    expect(result).toMatchObject({ stale: true, reason: '午間快照未包含上午 11:30 收盤價' });
  });

  test('陸股 13:00 重開後，11:30 快照重新受盤中 6 分鐘規則約束', () => {
    const result = assessIntradayFreshness('CN', {
      date: '2026-08-20',
      updatedAt: '2026-08-20T03:30:15.000Z',
      count: 3062,
    }, new Date('2026-08-20T05:01:00.000Z')); // 上海 13:01
    expect(result.stale).toBe(true);
    expect(result.reason).toMatch(/盤中快照已 91 分鐘未更新/);
  });
});
