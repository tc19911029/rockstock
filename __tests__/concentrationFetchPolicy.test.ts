import { shouldFetchExactConcentration } from '@/lib/chips/concentrationFetchPolicy';

describe('shouldFetchExactConcentration', () => {
  test('一般條件與訊號頁不發出昂貴請求', () => {
    expect(shouldFetchExactConcentration({ sideTab: 'conditions', activeBuyMethod: 'A', ticker: '6770.TW' })).toBe(false);
    expect(shouldFetchExactConcentration({ sideTab: 'signals', activeBuyMethod: 'A', ticker: '6770.TW' })).toBe(false);
  });

  test('進入籌碼頁時才載入台股集中度', () => {
    expect(shouldFetchExactConcentration({ sideTab: 'chip', activeBuyMethod: 'A', ticker: '6770.TW' })).toBe(true);
    expect(shouldFetchExactConcentration({ sideTab: 'chip', activeBuyMethod: 'A', ticker: '2330' })).toBe(true);
  });

  test('Y 法人偷買策略即使不在籌碼頁也需要集中度', () => {
    expect(shouldFetchExactConcentration({ sideTab: 'signals', activeBuyMethod: 'Y', ticker: '6770.TWO' })).toBe(true);
  });

  test('指數、陸股與空代碼不請求台股集中度', () => {
    expect(shouldFetchExactConcentration({ sideTab: 'chip', activeBuyMethod: 'A', ticker: '^TWII' })).toBe(false);
    expect(shouldFetchExactConcentration({ sideTab: 'chip', activeBuyMethod: 'Y', ticker: '600519.SS' })).toBe(false);
    expect(shouldFetchExactConcentration({ sideTab: 'chip', activeBuyMethod: 'Y', ticker: '' })).toBe(false);
  });
});
