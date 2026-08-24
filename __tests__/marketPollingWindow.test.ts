import { isMarketPollingWindow, isTaifexPollingWindow } from '@/lib/datasource/marketHours';

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

describe('isTaifexPollingWindow', () => {
  test('涵蓋日盤、夜盤與週六凌晨的跨日夜盤', () => {
    expect(isTaifexPollingWindow(new Date('2026-08-24T00:45:00.000Z'))).toBe(true); // 週一 08:45
    expect(isTaifexPollingWindow(new Date('2026-08-24T07:00:00.000Z'))).toBe(true); // 週一 15:00
    expect(isTaifexPollingWindow(new Date('2026-08-21T18:00:00.000Z'))).toBe(true); // 週六 02:00
  });

  test('日夜盤空檔、週日與假日不輪詢', () => {
    expect(isTaifexPollingWindow(new Date('2026-08-24T06:00:00.000Z'))).toBe(false); // 14:00
    expect(isTaifexPollingWindow(new Date('2026-08-24T21:30:00.000Z'))).toBe(false); // 05:30
    expect(isTaifexPollingWindow(new Date('2026-08-22T18:00:00.000Z'))).toBe(false); // 週日 02:00
    expect(isTaifexPollingWindow(new Date('2026-10-09T01:00:00.000Z'))).toBe(false); // 休市日 09:00
  });
});
