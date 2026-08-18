import { hasCoherentComplexShoulders } from '@/lib/analysis/v12LetterN';
import { choosePatternCandidate } from '@/lib/chart/patternSelection';

describe('型態品質與衝突選擇', () => {
  it('拒絕 3081 類型的肩膀平均值抵銷誤判', () => {
    expect(hasCoherentComplexShoulders(
      [1895, 1835],
      [2470, 1450],
      1335,
      'bottom',
    )).toBe(false);
  });

  it('接受兩側個別肩膀都位於同一肩帶的複式頭肩底', () => {
    expect(hasCoherentComplexShoulders(
      [190, 188],
      [192, 187],
      160,
      'bottom',
    )).toBe(true);
  });

  it('多空同時成立時優先選結構品質較高者，不被較新但較差的腳位蓋掉', () => {
    const bottom = { qualityScore: 97, pivots: [{ index: 10, price: 90, type: 'low' as const }] };
    const top = { qualityScore: 94, pivots: [{ index: 20, price: 110, type: 'high' as const }] };
    expect(choosePatternCandidate(bottom, top)).toBe(bottom);
  });

  it('品質同分時才用最近腳位破同分', () => {
    const bottom = { qualityScore: 96, pivots: [{ index: 10, price: 90, type: 'low' as const }] };
    const top = { qualityScore: 96, pivots: [{ index: 20, price: 110, type: 'high' as const }] };
    expect(choosePatternCandidate(bottom, top)).toBe(top);
  });
});
