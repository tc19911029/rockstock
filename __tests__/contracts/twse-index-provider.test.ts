import { mergeTwseIndexMonth } from '@/lib/datasource/TwseIndexProvider';

describe('TWSE 加權指數官方月資料', () => {
  test('合併官方 OHLC 與 FMTQIK 成交量並轉換民國日期', () => {
    const volumes = new Map([
      ['2026-08-14', { volume: 11_975_502 }],
    ]);
    const rows = mergeTwseIndexMonth({
      stat: 'OK',
      data: [
        ['115/08/14', '46,103.81', '46,402.60', '45,798.31', '45,811.01'],
      ],
    }, volumes);
    expect(rows).toEqual([{
      date: '2026-08-14',
      open: 46103.81,
      high: 46402.60,
      low: 45798.31,
      close: 45811.01,
      volume: 11_975_502,
    }]);
  });

  test('無效或空價格不會被寫成假 K 棒', () => {
    const rows = mergeTwseIndexMonth({
      data: [
        ['115/08/14', '--', '--', '--', '--'],
        ['bad-date', '1', '2', '0.5', '1.5'],
      ],
    }, new Map());
    expect(rows).toEqual([]);
  });
});
