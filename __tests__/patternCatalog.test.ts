import { isTopPatternType, TOP_PATTERN_TYPES } from '@/lib/analysis/patternCatalog';

describe('patternCatalog', () => {
  it('7 種頂部型態全部採用向下目標／向上失效方向', () => {
    expect(TOP_PATTERN_TYPES).toHaveLength(7);
    for (const patternType of TOP_PATTERN_TYPES) {
      expect(isTopPatternType(patternType)).toBe(true);
    }
  });

  it('底部型態不會被誤判成頂部', () => {
    expect(isTopPatternType('head-shoulder')).toBe(false);
    expect(isTopPatternType('n-shape')).toBe(false);
  });
});
