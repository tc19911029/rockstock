import {
  assertCompleteVerifyUniverse,
  calculateTargetDateCoverage,
} from '@/lib/datasource/DownloadVerifier';

describe('DownloadVerifier target-date coverage', () => {
  test('昨天有檔案但今天沒有 K 棒，不得算 covered', () => {
    expect(calculateTargetDateCoverage(100, 76, 0)).toBe(0.76);
  });

  test('已確認長期停牌／退市不列入活躍分母', () => {
    expect(calculateTargetDateCoverage(100, 95, 5)).toBe(1);
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
