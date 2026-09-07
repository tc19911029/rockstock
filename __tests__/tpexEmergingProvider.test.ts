import { adjustEmergingCandles, emergingDate, parseEmergingLive, parseEmergingMonth, parseEmergingSplits } from '@/lib/datasource/TpexEmergingProvider';
import { isEmergingPollingWindow } from '@/lib/datasource/marketHours';
import { computeIndicators } from '@/lib/indicators';

const fields = ['日期', '成交股數', '成交金額(元)', '成交最高', '成交最低', '成交均價', '筆數'];
const month = { stat: 'ok', tables: [{ fields, data: [
  ['115/08/19', '1,859,834', '1,731,378,914', '960.00', '877.00', '930.93', '4,592'],
  ['115/08/31', '23,297,398', '2,237,393,384', '109.00', '89.70', '96.04', '12,693'],
] }] };
const events = [{ date: '2026-08-20', ratio: 10 }];

describe('興櫃官方行情與換股銜接', () => {
  it('uses the official average rather than last price; preserves fractional lots', () => {
    const bars = parseEmergingMonth(month);
    expect(bars[0]).toEqual({ date: '2026-08-19', open: 930.93, close: 930.93, high: 960, low: 877, volume: 1859.834, priceBasis: 'esb-average' });
    expect(computeIndicators(bars)[0].priceBasis).toBe('esb-average');
  });
  it('adjusts 1:10 before the event and leaves raw storage and post-event bars unchanged', () => {
    const raw = parseEmergingMonth(month);
    const adjusted = adjustEmergingCandles(raw, events, '2026-09-07');
    expect(adjusted[0].close).toBeCloseTo(93.093);
    expect(adjusted[0].volume).toBeCloseTo(18598.34);
    expect(adjusted[1]).toEqual(raw[1]);
    expect(raw[0].close).toBe(930.93);
    expect(adjustEmergingCandles(raw, events, '2026-09-07')).toEqual(adjusted);
  });
  it('does not apply future actions to historical playback and composes multiple splits', () => {
    const raw = parseEmergingMonth(month);
    expect(adjustEmergingCandles(raw, events, '2026-08-19')).toEqual([raw[0]]);
    expect(adjustEmergingCandles(raw, [...events, { date: '2026-09-01', ratio: 2 }], '2026-09-07')[0].close).toBeCloseTo(930.93 / 20);
    const onEvent = { ...raw[0], date: events[0].date };
    expect(adjustEmergingCandles([onEvent], events, '2026-08-20')[0]).toEqual(onEvent);
  });
  it('does not create bars during suspension or accept a changed schema', () => {
    expect(parseEmergingMonth({ stat: 'ok', tables: [{ fields, data: [['115/08/20', '0', '0', '-', '-', '-', '0']] }] })).toEqual([]);
    expect(() => parseEmergingMonth({ stat: 'ok', tables: [{ fields: [], data: [] }] })).toThrow();
    expect(() => parseEmergingMonth({ stat: 'error' })).toThrow();
    expect(parseEmergingMonth({ stat: '查無股票代碼6696於104年01月之歷史資料,請重新輸入資料日期或股票代碼查詢', tables: [{ fields, data: [] }] })).toEqual([]);
  });
  it('reads event.date, not the event map key, and verifies the security identity', () => {
    const payload = { chart: { result: [{ meta: { symbol: '6696.TWO' }, events: { splits: { wrongKey: { date: 1787187600, numerator: 10000, denominator: 1000 } } } }] } };
    expect(parseEmergingSplits(payload, '6696')).toEqual(events);
    expect(() => parseEmergingSplits(payload, '2330')).toThrow();
    expect(() => parseEmergingSplits({ chart: { result: null } }, '6696')).toThrow();
  });
  it('reads the minute-updated official table timestamp and average, not last transaction', () => {
    const live = parseEmergingLive({ stat: 'ok', tables: [{ date: '115年09月07日 12:59:03',
      fields: ['代號', '日最高', '日最低', '日均價', '成交量', '成交'],
      data: [['6696', '200', '134', '175.61', '38,112,380', '178.50']] }] });
    expect(live[0]).toMatchObject({ Date: '1150907', Time: '125903', Average: '175.61' });
    expect(emergingDate(live[0].Date)).toBe('2026-09-07');
    expect(() => parseEmergingLive({ stat: 'ok', tables: [{ fields: [], data: [] }] })).toThrow();
  });
  it('keeps polling after mainboard close through ESB close and stops on weekends', () => {
    expect(isEmergingPollingWindow(new Date('2026-09-07T14:30:00+08:00'))).toBe(true);
    expect(isEmergingPollingWindow(new Date('2026-09-07T15:31:00+08:00'))).toBe(false);
    expect(isEmergingPollingWindow(new Date('2026-09-06T10:00:00+08:00'))).toBe(false);
  });
});

// These are derived-state checks, not visual hiding: playback must never expose
// executable buy/sell signals from synthetic open/close positions.
describe('興櫃均價不產生一般 K 線交易訊號', () => {
  it('keeps price/indicators but removes six-condition and pattern decisions', async () => {
    const { buildState } = await import('@/store/replay/buildState');
    const { createAccount } = await import('@/lib/engines/tradeEngine');
    const candles = computeIndicators(adjustEmergingCandles(parseEmergingMonth(month), events, '2026-09-07'));
    const state = buildState(candles, 1, createAccount(1_000_000));
    expect(state.visibleCandles).toHaveLength(2);
    expect(state.currentSignals).toEqual([]);
    expect(state.chartMarkers).toEqual([]);
    expect(state.sixConditions).toBeNull();
    expect(state.shortConditions).toBeNull();
    expect(state.winnerPatterns).toBeNull();
  });
});
