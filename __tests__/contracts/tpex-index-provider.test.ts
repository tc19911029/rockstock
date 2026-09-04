import { mergeTpexIndexTables } from '@/lib/datasource/TpexIndexProvider';

describe('TPEx ^TWOII 官方月資料', () => {
  test('合併西元 OHLC 與民國成交張數', () => {
    const candles = mergeTpexIndexTables(
      { tables: [{ data: [
        ['2026/08/14', '406.45', '409.29', '399.48', '400.95', '-5.17'],
      ] }] },
      { tables: [{ data: [
        ['115/08/14', '992,501', '237,372,937', '1,234,054', 400.95, -5.17],
      ] }] },
    );

    expect(candles).toEqual([{
      date: '2026-08-14',
      open: 406.45,
      high: 409.29,
      low: 399.48,
      close: 400.95,
      volume: 992501,
    }]);
  });

  test('成交量端點失敗時不輸出會被封存的零量 K 棒', () => {
    expect(mergeTpexIndexTables({ tables: [{ data: [
      ['2026/08/13', '391.82', '408.21', '390.71', '406.12', '4.10'],
    ] }] })).toEqual([]);
  });
});
