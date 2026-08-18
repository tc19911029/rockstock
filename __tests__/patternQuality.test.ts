import {
  getConservativeHorizontalNeckline,
  getPatternFormationBoundaryPrice,
  hasAlternatingDistinctPivots,
  hasCoherentComplexShoulders,
  projectPivotLinePrice,
  scorePatternGeometry,
} from '@/lib/analysis/v12LetterN';
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

  it('形狀分只看腳位幾何，三底越整齊且時間越對稱分數越高', () => {
    const match = (prices: number[], indices: number[]) => ({
      patternType: 'triple-bottom' as const,
      necklinePrice: 120,
      patternTargetPrice: 140,
      pivots: [
        { type: 'low' as const, price: prices[0], index: indices[0] },
        { type: 'low' as const, price: prices[1], index: indices[1] },
        { type: 'low' as const, price: prices[2], index: indices[2] },
        { type: 'high' as const, price: 120, index: 25 },
        { type: 'high' as const, price: 119, index: 15 },
      ],
    });
    const symmetric = scorePatternGeometry(match([100, 100.5, 99.5], [30, 20, 10]));
    const edgeCase = scorePatternGeometry(match([100, 104.5, 99.5], [30, 27, 10]));
    expect(symmetric.score).toBeGreaterThan(edgeCase.score);
    expect(symmetric.reasons).toEqual(expect.arrayContaining([expect.stringContaining('三點齊度')]));
  });

  it('N 字確認前以右腳 B 為失效邊界，不被更早前低放寬', () => {
    expect(getPatternFormationBoundaryPrice('n-shape', [
      { type: 'high', price: 120, index: 20 },
      { type: 'low', price: 100, index: 26 },
      { type: 'low', price: 80, index: 10 },
    ], 'bottom')).toBe(100);
  });

  it('下降頸線用兩個高點延伸到今日，不誤用歷史最高點當水平線', () => {
    expect(projectPivotLinePrice(
      { type: 'high', price: 120, index: 10 },
      { type: 'high', price: 100, index: 20 },
      25,
    )).toBe(90);
  });

  it('水平化底部頸線取最高壓力，必須站上全部內部高點', () => {
    expect(getConservativeHorizontalNeckline([108, 112], 'bottom')).toBe(112);
  });

  it('水平化頂部頸線取最低支撐，必須跌破全部內部低點', () => {
    expect(getConservativeHorizontalNeckline([92, 88], 'top')).toBe(88);
  });

  it('楔形／鑽石拒絕同一根 K 同時充當高低腳位', () => {
    expect(hasAlternatingDistinctPivots([
      { type: 'high', price: 110, index: 10 },
      { type: 'low', price: 90, index: 10 },
    ])).toBe(false);
  });

  it('楔形／鑽石接受不同 K 棒的高低交替腳位', () => {
    expect(hasAlternatingDistinctPivots([
      { type: 'high', price: 110, index: 10 },
      { type: 'low', price: 92, index: 12 },
      { type: 'high', price: 105, index: 15 },
      { type: 'low', price: 95, index: 18 },
    ])).toBe(true);
  });
});
