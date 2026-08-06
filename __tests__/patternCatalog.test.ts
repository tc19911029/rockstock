import {
  BOTTOM_PATTERN_TYPES,
  getLegacyBookAchievementRate,
  isPatternType,
  isTopPatternType,
  TOP_PATTERN_TYPES,
} from '@/lib/analysis/patternCatalog';

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

  it('15 種型態由單一 catalog 管理', () => {
    expect(BOTTOM_PATTERN_TYPES).toHaveLength(8);
    for (const patternType of [...BOTTOM_PATTERN_TYPES, ...TOP_PATTERN_TYPES]) {
      expect(isPatternType(patternType)).toBe(true);
    }
  });

  it('只回傳舊書可核對的達標率，不復活 N=75% 或頂部對稱估值', () => {
    expect(getLegacyBookAchievementRate('head-shoulder')).toBe(83);
    expect(getLegacyBookAchievementRate('double-bottom')).toBe(36);
    expect(getLegacyBookAchievementRate('n-shape')).toBeUndefined();
    expect(getLegacyBookAchievementRate('head-shoulder-top')).toBeUndefined();
  });
});
