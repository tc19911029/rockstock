import { isFinalTradingSnapshot } from '@/lib/health/l1l2Snapshot';

describe('isFinalTradingSnapshot', () => {
  test('台股收盤前快照不可拿來和收盤日 K 比較', () => {
    expect(isFinalTradingSnapshot('TW', '2026-08-14', '2026-08-14T01:06:00.000Z')).toBe(false);
  });

  test('台股 13:30 後同日快照可比較', () => {
    expect(isFinalTradingSnapshot('TW', '2026-08-14', '2026-08-14T05:30:00.000Z')).toBe(true);
  });

  test('陸股必須等到 15:00 且日期相同', () => {
    expect(isFinalTradingSnapshot('CN', '2026-08-14', '2026-08-14T06:59:00.000Z')).toBe(false);
    expect(isFinalTradingSnapshot('CN', '2026-08-14', '2026-08-14T07:00:00.000Z')).toBe(true);
    expect(isFinalTradingSnapshot('CN', '2026-08-13', '2026-08-14T07:00:00.000Z')).toBe(false);
  });

  test('無效時間不可比較', () => {
    expect(isFinalTradingSnapshot('TW', '2026-08-14', 'not-a-date')).toBe(false);
  });
});
