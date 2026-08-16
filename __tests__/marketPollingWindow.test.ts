import { isMarketPollingWindow } from '@/lib/datasource/marketHours';

describe('isMarketPollingWindow', () => {
  test('台股盤中與盤後定稿窗口允許輪詢', () => {
    expect(isMarketPollingWindow('TW', new Date('2026-08-14T01:00:00.000Z'))).toBe(true); // 09:00
    expect(isMarketPollingWindow('TW', new Date('2026-08-14T06:20:00.000Z'))).toBe(true); // 14:20
  });

  test('陸股盤中與盤後定稿窗口允許輪詢', () => {
    expect(isMarketPollingWindow('CN', new Date('2026-08-14T01:15:00.000Z'))).toBe(true); // 09:15
    expect(isMarketPollingWindow('CN', new Date('2026-08-14T07:20:00.000Z'))).toBe(true); // 15:20
  });

  test('週末、假日、盤前與深夜不輪詢', () => {
    expect(isMarketPollingWindow('TW', new Date('2026-08-16T02:00:00.000Z'))).toBe(false); // Sunday
    expect(isMarketPollingWindow('TW', new Date('2026-10-09T02:00:00.000Z'))).toBe(false); // holiday
    expect(isMarketPollingWindow('TW', new Date('2026-08-14T00:30:00.000Z'))).toBe(false); // 08:30
    expect(isMarketPollingWindow('CN', new Date('2026-08-14T12:00:00.000Z'))).toBe(false); // 20:00
  });
});
