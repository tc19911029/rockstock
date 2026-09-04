import { dedupeStockEntries } from '@/lib/scanner/eastMoneyApi';

describe('dedupeStockEntries', () => {
  test('依 symbol 去重並保留較完整的名稱與產業', () => {
    expect(dedupeStockEntries([
      { symbol: '600000.SS', name: '浦發銀行' },
      { symbol: '000001.SZ', name: '平安銀行', industry: '銀行' },
      { symbol: '600000.SS', name: '', industry: '銀行' },
    ])).toEqual([
      { symbol: '600000.SS', name: '浦發銀行', industry: '銀行' },
      { symbol: '000001.SZ', name: '平安銀行', industry: '銀行' },
    ]);
  });

  test('沒有重複時維持原始順序', () => {
    const stocks = [
      { symbol: '600000.SS', name: '浦發銀行' },
      { symbol: '000001.SZ', name: '平安銀行' },
    ];
    expect(dedupeStockEntries(stocks)).toEqual(stocks);
  });
});
