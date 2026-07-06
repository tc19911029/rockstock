/**
 * 書-15：內困三紅（多方型態，內困三黑之鏡像）— klineComboRules
 * 長黑 + 母子懷抱紅K + 長紅突破長黑高點 → BUY 變盤反轉確認。
 */
import { innerThreeRed } from '@/lib/rules/klineComboRules';
import type { CandleWithIndicators } from '@/types';

function bar(open: number, close: number, high?: number, low?: number): CandleWithIndicators {
  return {
    date: 'd', open, close,
    high: high ?? Math.max(open, close),
    low: low ?? Math.min(open, close),
    volume: 1000,
  } as unknown as CandleWithIndicators;
}

describe('innerThreeRed 內困三紅', () => {
  test('長黑 → 母子紅 → 長紅突破長黑高 → BUY', () => {
    // c0 長黑：開 100 收 92（body 8%），high 100 low 92
    // c1 母子紅：開 94 收 97（被 c0 [92,100] 包住），紅K
    // c2 長紅：開 96 收 103（突破 c0 high 100，body≈7%）
    const candles = [
      bar(100, 92, 100, 92),
      bar(94, 97, 98, 93),
      bar(96, 103, 103.5, 95),
    ];
    const sig = innerThreeRed.evaluate([bar(90, 90), ...candles], 3);
    expect(sig).not.toBeNull();
    expect(sig?.type).toBe('BUY');
    expect(sig?.label).toContain('內困三紅');
  });

  test('第三根未突破長黑高 → 不觸發', () => {
    const candles = [
      bar(100, 92, 100, 92),
      bar(94, 97, 98, 93),
      bar(95, 99, 99.5, 94), // 收 99 < 長黑高 100
    ];
    expect(innerThreeRed.evaluate([bar(90,90), ...candles], 3)).toBeNull();
  });

  test('中間不是被包住的紅K（母子不成立）→ 不觸發', () => {
    const candles = [
      bar(100, 92, 100, 92),
      bar(94, 101, 102, 93), // high 102 > c0 high 100，未被包住
      bar(96, 103, 103.5, 95),
    ];
    expect(innerThreeRed.evaluate([bar(90,90), ...candles], 3)).toBeNull();
  });
});
