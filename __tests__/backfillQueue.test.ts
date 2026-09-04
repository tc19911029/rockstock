import {
  reconcileBackfillQueue,
  type BackfillQueue,
} from '@/lib/datasource/BackfillQueue';

const gap = (fromDate: string, toDate: string) => ({
  fromDate,
  toDate,
  calendarDays: 20,
  tradingDays: 12,
});

describe('reconcileBackfillQueue', () => {
  test('相同 ranges 保留失敗次數並清除本輪已不存在的 symbol', () => {
    const queue: BackfillQueue = {
      market: 'TW',
      updatedAt: '2026-09-03T00:00:00.000Z',
      items: [
        {
          symbol: '2330.TW',
          ranges: [{ from: '2026-07-01', to: '2026-07-20' }],
          detectedAt: '2026-08-01T00:00:00.000Z',
          attempts: 3,
          lastAttemptAt: '2026-09-01T00:00:00.000Z',
        },
        {
          symbol: '2317.TW',
          ranges: [{ from: '2026-06-01', to: '2026-06-20' }],
          detectedAt: '2026-08-01T00:00:00.000Z',
          attempts: 1,
        },
      ],
    };

    const result = reconcileBackfillQueue(queue, [
      { symbol: '2330.TW', gaps: [gap('2026-07-01', '2026-07-20')] },
    ]);

    expect(result).toMatchObject({ added: 0, reset: 0, cleared: 1 });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ symbol: '2330.TW', attempts: 3 });
  });

  test('ranges 改變時重設嘗試狀態，避免新缺口被舊 abandoned 狀態跳過', () => {
    const queue: BackfillQueue = {
      market: 'CN',
      updatedAt: '2026-09-03T00:00:00.000Z',
      items: [{
        symbol: '600000.SS',
        ranges: [{ from: '2022-01-01', to: '2022-02-01' }],
        detectedAt: '2022-02-02T00:00:00.000Z',
        attempts: 5,
        abandonedReason: 'provider returned empty',
      }],
    };

    const result = reconcileBackfillQueue(
      queue,
      [{ symbol: '600000.SS', gaps: [gap('2026-07-01', '2026-07-20')] }],
      '2026-09-04T00:00:00.000Z',
    );

    expect(result.reset).toBe(1);
    expect(queue.items[0]).toEqual({
      symbol: '600000.SS',
      ranges: [{ from: '2026-07-01', to: '2026-07-20' }],
      detectedAt: '2026-09-04T00:00:00.000Z',
      attempts: 0,
    });
  });

  test('新增項目會去重並排序 ranges', () => {
    const queue: BackfillQueue = { market: 'TW', updatedAt: '', items: [] };
    const duplicate = gap('2026-08-01', '2026-08-20');

    const result = reconcileBackfillQueue(queue, [{
      symbol: '2454.TW',
      gaps: [duplicate, gap('2026-07-01', '2026-07-20'), duplicate],
    }], '2026-09-04T00:00:00.000Z');

    expect(result.added).toBe(1);
    expect(queue.items[0].ranges).toEqual([
      { from: '2026-07-01', to: '2026-07-20' },
      { from: '2026-08-01', to: '2026-08-20' },
    ]);
  });
});
