import {
  assertCompleteVerifyUniverse,
  calculateTargetDateCoverage,
  isConfirmedNoTradeQuote,
} from '@/lib/datasource/DownloadVerifier';
import type { IntradayQuote } from '@/lib/datasource/IntradayCache';

function quote(overrides: Partial<IntradayQuote> = {}): IntradayQuote {
  return {
    symbol: '000001', name: '測試', open: 10, high: 10, low: 10, close: 10,
    volume: 0, prevClose: 10, changePercent: 0, ...overrides,
  };
}

describe('DownloadVerifier target-date coverage', () => {
  test('昨天有檔案但今天沒有 K 棒，不得算 covered', () => {
    expect(calculateTargetDateCoverage(100, 76, 0)).toBe(0.76);
  });

  test('已確認長期停牌／退市不列入活躍分母', () => {
    expect(calculateTargetDateCoverage(100, 95, 5)).toBe(1);
  });

  test('最終快照確認無成交與待上市代碼不列入活躍分母', () => {
    expect(calculateTargetDateCoverage(100, 93, 2, 5)).toBe(1);
  });

  test('TW 只接受交易所明確標記的零量無成交', () => {
    expect(isConfirmedNoTradeQuote('TW', quote({ isActualTrade: false }))).toBe(true);
    expect(isConfirmedNoTradeQuote('TW', quote({ isActualTrade: true }))).toBe(false);
  });

  test('CN 只接受零量、平棒且等於昨收的停牌型態', () => {
    expect(isConfirmedNoTradeQuote('CN', quote())).toBe(true);
    expect(isConfirmedNoTradeQuote('CN', quote({ close: 10.1, high: 10.1, changePercent: 1 }))).toBe(false);
    expect(isConfirmedNoTradeQuote('CN', quote({ volume: 100 }))).toBe(false);
  });

  test('沒有活躍股票時回 0，不產生 NaN', () => {
    expect(calculateTargetDateCoverage(5, 0, 5)).toBe(0);
  });

  test('小型 fallback 母體不得覆寫全市場驗證報告', () => {
    expect(() => assertCompleteVerifyUniverse('TW', 30)).toThrow('拒絕覆寫');
    expect(() => assertCompleteVerifyUniverse('CN', 2699)).toThrow('拒絕覆寫');
    expect(() => assertCompleteVerifyUniverse('TW', 1500)).not.toThrow();
    expect(() => assertCompleteVerifyUniverse('CN', 2700)).not.toThrow();
  });
});
