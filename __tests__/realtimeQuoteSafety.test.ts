import { parseRealtimeQuote } from '@/app/api/realtime/route';

describe('legacy realtime quote safety', () => {
  test('z 無成交時不再拿最低價或昨收冒充現價', () => {
    expect(parseRealtimeQuote({
      c: '3081',
      z: '-',
      l: '3370',
      y: '3255',
      d: '20260827',
      t: '13:30:00',
    }, new Date('2026-08-27T05:30:10.000Z'))).toBeNull();
  });

  test('實際成交價保留來源日期與時間', () => {
    expect(parseRealtimeQuote({
      c: '3081',
      n: '聯亞',
      z: '3370',
      y: '3255',
      o: '3300',
      h: '3500',
      l: '3280',
      d: '20260827',
      t: '13:30:00',
    }, new Date('2026-08-27T05:30:10.000Z'))).toMatchObject({
      price: 3370,
      date: '2026-08-27',
      updatedAt: '2026-08-27T05:30:00.000Z',
      stale: false,
      source: 'mis',
    });
  });

  test('真正零成交標的只以昨收作參考，並明確標 no-trade', () => {
    expect(parseRealtimeQuote({
      c: '1538', z: '-', y: '40.5', o: '-', h: '-', l: '-', v: '0',
      d: '20260827', t: '13:30:00',
    }, new Date('2026-08-27T05:30:10.000Z'))).toMatchObject({
      price: 40.5,
      changePct: 0,
      status: 'no-trade',
      stale: false,
    });
  });
});
