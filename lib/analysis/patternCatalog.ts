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

const TOP_PATTERN_SET: ReadonlySet<string> = new Set(TOP_PATTERN_TYPES);

export function isTopPatternType(patternType: string): patternType is TopPatternType {
  return TOP_PATTERN_SET.has(patternType);
}
