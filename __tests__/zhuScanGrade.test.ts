/**
 * Scan 模式專用 grade — 只看 3 燈（technical/chip/theme）的 ABCDE 規則
 */

import { computeScanGradeFromLights } from '@/lib/ai/zhuLights';
import type { Light, ZhuLights } from '@/lib/ai/zhuTypes';

function l(t: Light, c: Light, th: Light): ZhuLights {
  // fund/val 在 scan 模式必 gray，不影響 grade
  return { technical: t, chip: c, theme: th, fundamental: 'gray', valuation: 'gray' };
}

describe('computeScanGradeFromLights', () => {
  test('3 燈全綠 → A', () => {
    expect(computeScanGradeFromLights(l('green', 'green', 'green'))).toBe('A');
  });
  test('技術綠 + 籌碼綠 + 題材黃 (score 5) → A', () => {
    expect(computeScanGradeFromLights(l('green', 'green', 'yellow'))).toBe('A');
  });
  test('技術綠 + 籌碼黃 + 題材黃 (score 4) → B', () => {
    expect(computeScanGradeFromLights(l('green', 'yellow', 'yellow'))).toBe('B');
  });
  test('技術綠 + 籌碼 gray + 題材黃 (score 3) → C', () => {
    expect(computeScanGradeFromLights(l('green', 'gray', 'yellow'))).toBe('C');
  });
  test('技術黃 + 籌碼黃 + 題材黃 (score 3) → C', () => {
    expect(computeScanGradeFromLights(l('yellow', 'yellow', 'yellow'))).toBe('C');
  });
  test('技術黃 + 籌碼 gray + 題材黃 (score 2) → D', () => {
    expect(computeScanGradeFromLights(l('yellow', 'gray', 'yellow'))).toBe('D');
  });
  test('技術紅 + 籌碼紅 → E（最危險組合）', () => {
    expect(computeScanGradeFromLights(l('red', 'red', 'green'))).toBe('E');
  });
  test('全 gray → E', () => {
    expect(computeScanGradeFromLights(l('gray', 'gray', 'gray'))).toBe('E');
  });
  test('1727 案例：sixCond=6 多頭 + chipScore null + 同產業孤鳥 → C 級（合理）', () => {
    // technical=green, chip=gray (chipScore null), theme=yellow (sameIndustryCount=1 不滿足 ≥3)
    expect(computeScanGradeFromLights(l('green', 'gray', 'yellow'))).toBe('C');
  });
});
