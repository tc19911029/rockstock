import {
  getTWClosingL2Slot,
  isCNMarketLunchBreak,
  isCNMarketOpen,
  isMarketPollingWindow,
  isTaifexPollingWindow,
} from '@/lib/datasource/marketHours';

describe('台股收盤 L2 定格時間槽', () => {
  test('交易日只在 13:30 與 13:35 各開一個時間槽', () => {
    expect(getTWClosingL2Slot(new Date('2026-08-14T05:30:05.000Z'))).toBe('13:30');
    expect(getTWClosingL2Slot(new Date('2026-08-14T05:35:55.000Z'))).toBe('13:35');
    expect(getTWClosingL2Slot(new Date('2026-08-14T05:34:59.000Z'))).toBeNull();
    expect(getTWClosingL2Slot(new Date('2026-08-14T05:36:00.000Z'))).toBeNull();
  });

  test('週末與休市日不開收盤定格時間槽', () => {
    expect(getTWClosingL2Slot(new Date('2026-08-16T05:35:00.000Z'))).toBeNull();
    expect(getTWClosingL2Slot(new Date('2026-10-09T05:35:00.000Z'))).toBeNull();
  });
});

describe('isMarketPollingWindow', () => {
  test('台股盤中與盤後定稿窗口允許輪詢', () => {
    expect(isMarketPollingWindow('TW', new Date('2026-08-14T01:00:00.000Z'))).toBe(true); // 09:00
    expect(isMarketPollingWindow('TW', new Date('2026-08-14T06:20:00.000Z'))).toBe(true); // 14:20
  });

  test('陸股盤中與盤後定稿窗口允許輪詢', () => {
    expect(isMarketPollingWindow('CN', new Date('2026-08-14T01:15:00.000Z'))).toBe(true); // 09:15
    expect(isMarketPollingWindow('CN', new Date('2026-08-14T05:00:00.000Z'))).toBe(true); // 13:00
    expect(isMarketPollingWindow('CN', new Date('2026-08-14T07:20:00.000Z'))).toBe(true); // 15:20
  });

  test('陸股 11:30 保留上午最後刷新，午休前端只讀快照，13:00 恢復交易', () => {
    const morningClose = new Date('2026-08-14T03:30:00.000Z');
    const lunch = new Date('2026-08-14T04:15:00.000Z');
    const afternoonOpen = new Date('2026-08-14T05:00:00.000Z');

    expect(isCNMarketOpen(morningClose)).toBe(true);
    expect(isCNMarketLunchBreak(morningClose)).toBe(false);
    expect(isCNMarketOpen(lunch)).toBe(false);
    expect(isCNMarketLunchBreak(lunch)).toBe(true);
    // 前端 timer 保留，才能在 13:00 自動恢復；後端 vendor 抓取只看 isCNMarketOpen。
    expect(isMarketPollingWindow('CN', lunch)).toBe(true);
    expect(isCNMarketOpen(afternoonOpen)).toBe(true);
    expect(isCNMarketLunchBreak(afternoonOpen)).toBe(false);
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
