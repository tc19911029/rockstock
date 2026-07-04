/**
 * bearishPiercingHigh — 貫穿 vs 類母子變盤分流（2026-07-04 修）
 *
 * 誤殺案例：兆易创新 603986 2026-06-23 — 黑K開低（680 < 昨收 689.7）、
 * 收 640.99 僅刺穿昨紅K開盤 643 的 0.3%，被判「高檔長黑貫穿→立即出場」，
 * 次日開平走高 +10%。書本貫穿=「開高走低一路向下」；開低+淺穿=類母子變盤，
 * CH2 鐵律：變盤線次日開盤確認。
 */
import { describe, it, expect } from '@jest/globals';
import { bearishPiercingHigh } from '@/lib/rules/twoBarReversalRules';
import type { CandleWithIndicators } from '@/types';

/** 上升波 20 根（頭頭高底底高）+ 自訂末兩根 */
function makeCandles(red: Partial<CandleWithIndicators>, black: Partial<CandleWithIndicators>): CandleWithIndicators[] {
  const bars: CandleWithIndicators[] = [];
  for (let i = 0; i < 20; i++) {
    const c = 500 + i * 7;
    bars.push({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      open: c - 5, high: c + 3, low: c - 8, close: c, volume: 10000,
    } as CandleWithIndicators);
  }
  bars.push({ date: '2026-06-22', volume: 20000, ...red } as CandleWithIndicators);
  bars.push({ date: '2026-06-23', volume: 25000, ...black } as CandleWithIndicators);
  return bars;
}

// 兆易创新真實 OHLC
const RED_622 = { open: 643, high: 689.7, low: 635, close: 689.7 };

describe('bearishPiercingHigh — 貫穿 vs 類母子', () => {
  it('兆易案例：黑K開低+僅刺穿0.3% → WATCH 次日確認（不再硬出場）', () => {
    const candles = makeCandles(RED_622, { open: 680, high: 688.8, low: 636, close: 640.99 });
    const r = bearishPiercingHigh.evaluate(candles, candles.length - 1, undefined as never);
    expect(r).not.toBeNull();
    expect(r!.type).toBe('WATCH');
    expect(r!.label).toContain('次日確認');
  });

  it('真貫穿：黑K開高走低殺穿整根 → SELL', () => {
    const candles = makeCandles(RED_622, { open: 692, high: 693, low: 638, close: 640 });
    const r = bearishPiercingHigh.evaluate(candles, candles.length - 1, undefined as never);
    expect(r).not.toBeNull();
    expect(r!.type).toBe('SELL');
    expect(r!.label).toBe('高檔長黑貫穿');
  });

  it('開低但深穿 ≥1%（跳空續殺）→ 仍 SELL', () => {
    const candles = makeCandles(RED_622, { open: 680, high: 683, low: 628, close: 630 });
    const r = bearishPiercingHigh.evaluate(candles, candles.length - 1, undefined as never);
    expect(r).not.toBeNull();
    expect(r!.type).toBe('SELL');
  });

  it('沒跌破紅K開盤 → null（由覆蓋/遭遇規則接手）', () => {
    const candles = makeCandles(RED_622, { open: 685, high: 688, low: 650, close: 655 });
    const r = bearishPiercingHigh.evaluate(candles, candles.length - 1, undefined as never);
    expect(r).toBeNull();
  });
});
