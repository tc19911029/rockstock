import { detectValuationMarket } from '@/lib/valuation/market';

describe('detectValuationMarket', () => {
  it.each([
    ['3081', 'TW'],
    ['3081.TWO', 'TW'],
    ['2330.TW', 'TW'],
    ['600519', 'CN'],
    ['600519.SS', 'CN'],
    ['000988.SZ', 'CN'],
  ])('辨識 %s 為 %s', (symbol, market) => {
    expect(detectValuationMarket(symbol)).toBe(market);
  });

  it.each(['AAPL', '3081.SS', '600519.TW', '../3081'])('拒絕不合法或市場後綴衝突的代號 %s', symbol => {
    expect(detectValuationMarket(symbol)).toBeNull();
  });
});
