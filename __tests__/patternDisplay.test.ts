import type { Pivot } from '@/lib/analysis/trendAnalysis';
import {
  getPivotLabels,
  getPivotMarkerLabel,
  resolvePatternPivotSnapshots,
} from '@/lib/chart/patternDisplay';

const pivot = (type: Pivot['type'], price: number, index = 0): Pivot => ({ type, price, index });

describe('patternDisplay', () => {
  it('一般轉折點直接標示頭或底', () => {
    expect(getPivotMarkerLabel(pivot('high', 123.456))).toBe('頭');
    expect(getPivotMarkerLabel(pivot('low', 98))).toBe('底');
  });

  it('倒 N 腳位依 detector 回傳順序標成 C/A/B', () => {
    const pivots = [pivot('high', 110, 31), pivot('high', 120, 20), pivot('low', 90, 26)];
    expect(getPivotLabels('inverted-n-top', pivots)).toEqual(['C', 'A', 'B']);
  });

  it('N 字底把目標公式使用的前低一併標出', () => {
    const pivots = [pivot('high', 120, 20), pivot('low', 100, 26), pivot('low', 80, 10)];
    expect(getPivotLabels('n-shape', pivots)).toEqual(['A', 'B', '前低']);
  });

  it('一字頂使用箱頂／支撐語意，不再沿用島狀反轉標籤', () => {
    const labels = getPivotLabels('one-line-top', [pivot('high', 100), pivot('low', 95)]);
    expect(labels).toEqual(['箱頂', '支撐']);
    expect(labels).not.toContain('島頂');
    expect(labels).not.toContain('缺口');
  });

  it('複式頭肩頂同時標出頭、肩與頸線，不漏掉低點', () => {
    const pivots = [
      pivot('high', 130, 20),
      pivot('high', 110, 30),
      pivot('high', 108, 10),
      pivot('low', 90, 25),
      pivot('low', 92, 15),
    ];
    expect(getPivotLabels('complex-head-shoulder-top', pivots)).toEqual([
      '頭', '肩1', '肩2', '頸1', '頸2',
    ]);
  });

  it('鎖定腳位依日期精確還原，不把不存在的日期硬套到鄰近 K 棒', () => {
    const resolved = resolvePatternPivotSnapshots([
      { date: '2026-07-01', price: 80, type: 'low' },
      { date: '2026-07-03', price: 100, type: 'high' },
      { date: '2026-07-09', price: 90, type: 'low' },
    ], ['2026-07-01', '2026-07-02', '2026-07-03*']);
    expect(resolved).toEqual([
      { index: 0, price: 80, type: 'low' },
      { index: 2, price: 100, type: 'high' },
    ]);
  });
});
