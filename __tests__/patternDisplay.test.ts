import type { Pivot } from '@/lib/analysis/trendAnalysis';
import {
  formatPivotPrice,
  getPivotLabels,
  getPivotMarkerText,
} from '@/lib/chart/patternDisplay';

const pivot = (type: Pivot['type'], price: number, index = 0): Pivot => ({ type, price, index });

describe('patternDisplay', () => {
  it('頭底 marker 明確帶出可核對的價格', () => {
    expect(getPivotMarkerText(pivot('high', 123.456))).toBe('頭 123.46');
    expect(getPivotMarkerText(pivot('low', 98))).toBe('底 98.00');
    expect(formatPivotPrice(Number.NaN)).toBe('—');
  });

  it('倒 N 腳位依 detector 回傳順序標成 C/A/B', () => {
    const pivots = [pivot('high', 110, 31), pivot('high', 120, 20), pivot('low', 90, 26)];
    expect(getPivotLabels('inverted-n-top', pivots)).toEqual(['C', 'A', 'B']);
  });

  it('一字頂使用箱頂／支撐語意，不再沿用島狀反轉標籤', () => {
    const labels = getPivotLabels('one-line-top', [pivot('high', 100), pivot('low', 95)]);
    expect(labels).toEqual(['箱頂', '支撐']);
    expect(labels).not.toContain('島頂');
    expect(labels).not.toContain('缺口');
  });
});
