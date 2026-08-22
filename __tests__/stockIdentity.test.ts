import {
  UNRESOLVED_STOCK_NAME,
  isPlaceholderStockName,
  stockCodeOf,
  stockDisplayLabel,
  stockDisplayName,
} from '@/lib/stocks/stockIdentity';

describe('stockIdentity', () => {
  test.each([
    ['', '2330.TW'],
    ['2330', '2330.TW'],
    ['2330.TW', '2330.TW'],
    ['3081', '3081.TWO'],
    ['002821', '002821.SZ'],
    ['002821.SZ', '002821.SZ'],
    [UNRESOLVED_STOCK_NAME, '2330.TW'],
  ])('拒絕代號或待補文案冒充名稱：%p / %p', (name, symbol) => {
    expect(isPlaceholderStockName(name, symbol)).toBe(true);
    expect(stockDisplayName(name, symbol)).toBe(UNRESOLVED_STOCK_NAME);
  });

  test('正式名稱永遠作主標，代號只作輔助資訊', () => {
    expect(stockDisplayName(' 台積電 ', '2330.TW')).toBe('台積電');
    expect(stockDisplayLabel('台積電', '2330.TW')).toBe('台積電（2330.TW）');
    expect(stockCodeOf('3081.TWO')).toBe('3081');
  });
});
