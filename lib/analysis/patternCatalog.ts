/**
 * 所有頂部型態的單一真實清單。
 *
 * 型態方向會影響目標、失效價與持股頁顯示，禁止各頁自行維護不完整的 Set。
 */
export const TOP_PATTERN_TYPES = [
  'head-shoulder-top',
  'triple-top',
  'double-top',
  'complex-head-shoulder-top',
  'inverted-n-top',
  'long-double-top',
  'one-line-top',
] as const;

export type TopPatternType = (typeof TOP_PATTERN_TYPES)[number];

export const BOTTOM_PATTERN_TYPES = [
  'head-shoulder',
  'triple-bottom',
  'rounding-bottom',
  'complex-head-shoulder',
  'falling-diamond',
  'descending-wedge',
  'double-bottom',
  'n-shape',
] as const;

export type BottomPatternType = (typeof BOTTOM_PATTERN_TYPES)[number];
export type PatternType = BottomPatternType | TopPatternType;

/**
 * 《抓住飆股》附錄明載的底部型態「達成目標價」比例。
 *
 * 這不是 Rockstock 回測勝率，也不是 2026 線上課公布的預測機率；UI 必須標成
 * 「舊書達標率」。N 字底與線上課頂部六型沒有可核對的同名數字，刻意不填。
 */
const LEGACY_BOOK_ACHIEVEMENT_RATE: Readonly<Partial<Record<PatternType, number>>> = {
  'head-shoulder': 83,
  'triple-bottom': 95,
  'rounding-bottom': 85,
  'complex-head-shoulder': 80,
  'falling-diamond': 80,
  'descending-wedge': 90,
  'double-bottom': 36,
};

export interface PatternPivotSnapshot {
  date: string;
  price: number;
  type: 'high' | 'low';
}

const TOP_PATTERN_SET: ReadonlySet<string> = new Set(TOP_PATTERN_TYPES);

export function isTopPatternType(patternType: string): patternType is TopPatternType {
  return TOP_PATTERN_SET.has(patternType);
}

const BOTTOM_PATTERN_SET: ReadonlySet<string> = new Set(BOTTOM_PATTERN_TYPES);

export function isBottomPatternType(patternType: string): patternType is BottomPatternType {
  return BOTTOM_PATTERN_SET.has(patternType);
}

export function isPatternType(patternType: string): patternType is PatternType {
  return isBottomPatternType(patternType) || isTopPatternType(patternType);
}

export function getLegacyBookAchievementRate(patternType: string): number | undefined {
  return isPatternType(patternType) ? LEGACY_BOOK_ACHIEVEMENT_RATE[patternType] : undefined;
}
