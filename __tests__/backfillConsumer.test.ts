import { unresolvedBackfillRanges } from '@/lib/datasource/BackfillConsumer';

describe('BackfillConsumer', () => {
  test('補拉後仍重疊的 gap 必須留在 queue', () => {
    const ranges = [
      { from: '2026-04-01', to: '2026-04-20' },
      { from: '2026-06-01', to: '2026-06-20' },
    ];
    const unresolved = unresolvedBackfillRanges(ranges, [{
      fromDate: '2026-04-05',
      toDate: '2026-04-18',
      calendarDays: 13,
      tradingDays: 9,
    }]);
    expect(unresolved).toEqual([ranges[0]]);
  });

  test('所有 gap 消失才可確認 queue item 已修復', () => {
    expect(unresolvedBackfillRanges(
      [{ from: '2026-04-01', to: '2026-04-20' }],
      [{ fromDate: '2025-01-01', toDate: '2025-02-01', calendarDays: 31, tradingDays: 20 }],
    )).toEqual([]);
  });

  test('空 range 不會被任何無關 gap 誤判為未完成', () => {
    expect(unresolvedBackfillRanges([], [
      { fromDate: '2025-01-01', toDate: '2025-02-01', calendarDays: 31, tradingDays: 20 },
    ])).toEqual([]);
  });
});
