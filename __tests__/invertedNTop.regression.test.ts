import { detectTopPatternsStructure } from '@/lib/analysis/v12LetterN';
import type { CandleWithIndicators } from '@/types';

function makeCandle(index: number, close: number, high: number, low: number): CandleWithIndicators {
  return {
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    open: close,
    high,
    low,
    close,
    volume: 1_000,
    ma5: 100,
  };
}

describe('倒 N 字頂 regression', () => {
  it('能找到依時間順序位於前高 A 與較低反彈高 C 之間的低點 B', () => {
    const candles: CandleWithIndicators[] = [];

    // MA5 上方第一段：前高 A（index 20，120）
    for (let i = 0; i <= 22; i++) {
      candles.push(makeCandle(i, 105, i === 20 ? 120 : 108, 103));
    }
    // MA5 下方：A、C 之間的 B（index 26，90）
    for (let i = 23; i <= 28; i++) {
      candles.push(makeCandle(i, 95, 97, i === 26 ? 90 : 93));
    }
    // 再回 MA5 上方：較低的 C（index 31，110）
    for (let i = 29; i <= 32; i++) {
      candles.push(makeCandle(i, 105, i === 31 ? 110 : 107, 103));
    }
    // 最新段跌回 MA5 下方，完成倒 N 頭部。
    for (let i = 33; i <= 39; i++) {
      candles.push(makeCandle(i, 95, 97, 93));
    }

    const result = detectTopPatternsStructure(candles, candles.length - 1);

    // structure API 只回結構、刻意不把「已跌破」標成 triggered；交易 gate 由 detectTopPatterns 負責。
    expect(result.triggered).toBe(false);
    expect(result.patternType).toBe('inverted-n-top');
    expect(result.pivots?.map(p => [p.index, p.price])).toEqual([
      [31, 110], // C
      [20, 120], // A
      [26, 90],  // B
    ]);
    expect(result.necklinePrice).toBe(90);
    expect(result.patternTargetPrice).toBe(80);
    expect(result.achievementRate).toBeUndefined();
  });
});
