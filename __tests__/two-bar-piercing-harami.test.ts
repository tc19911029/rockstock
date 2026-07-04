/**
 * 兩根K棒轉折規則 — 課程 CH2-6/2-7 六組判準忠實度（2026-07-04 修）
 *
 * 誤殺案例：兆易创新 603986 2026-06-23 — -5.7% 長黑整根被昨日紅K包住（課程第4組母子），
 * 之前被 harami 的 2% 子線實體上限擋掉、流到貫穿規則判「立即出場」，次日 +10%。
 * 課程判準：
 *   第4組 母子＝沒破紅K低點、整根被包住（右邊是**長黑**，不限小實體）→ 止漲、次日確認
 *   第6組 破底貫穿＝收盤**破紅K低點**（不是破實體開盤價）→ 一路向下、當天出
 * 低檔為完全鏡像（④光明在望／⑥破高貫穿=收盤過黑K**高點**）。
 */
import { describe, it, expect } from '@jest/globals';
import {
  bearishPiercingHigh, bearishHaramiHigh,
  bullishPiercingLow, bullishHaramiLow,
  bearishEngulfingHigh,
} from '@/lib/rules/twoBarReversalRules';
import type { CandleWithIndicators } from '@/types';

function upCandles(red: Partial<CandleWithIndicators>, last: Partial<CandleWithIndicators>): CandleWithIndicators[] {
  const bars: CandleWithIndicators[] = [];
  for (let i = 0; i < 20; i++) {
    const c = 500 + i * 7;
    bars.push({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, open: c - 5, high: c + 3, low: c - 8, close: c, volume: 10000 } as CandleWithIndicators);
  }
  bars.push({ date: '2026-06-22', volume: 20000, ...red } as CandleWithIndicators);
  bars.push({ date: '2026-06-23', volume: 25000, ...last } as CandleWithIndicators);
  return bars;
}

function downCandles(black: Partial<CandleWithIndicators>, last: Partial<CandleWithIndicators>): CandleWithIndicators[] {
  const bars: CandleWithIndicators[] = [];
  for (let i = 0; i < 20; i++) {
    const c = 700 - i * 7;
    bars.push({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, open: c + 5, high: c + 8, low: c - 3, close: c, volume: 10000 } as CandleWithIndicators);
  }
  bars.push({ date: '2026-06-22', volume: 20000, ...black } as CandleWithIndicators);
  bars.push({ date: '2026-06-23', volume: 25000, ...last } as CandleWithIndicators);
  return bars;
}

// 兆易创新真實 OHLC
const RED_622 = { open: 643, high: 689.7, low: 635, close: 689.7 };
const GY_623 = { open: 680, high: 688.8, low: 636, close: 640.99 };

describe('高檔：課程 CH2-6 六組判準', () => {
  it('兆易案例：長黑整根被包住 → 母子懷抱 WATCH（harami 不再被 2% 上限擋掉）', () => {
    const candles = upCandles(RED_622, GY_623);
    const h = bearishHaramiHigh.evaluate(candles, candles.length - 1, undefined as never);
    expect(h).not.toBeNull();
    expect(h!.type).toBe('WATCH');
    // 貫穿規則讓位（整根被包住 → 交給母子）
    const p = bearishPiercingHigh.evaluate(candles, candles.length - 1, undefined as never);
    expect(p).toBeNull();
  });

  it('傳統小子線母子（紅K小實體）仍觸發', () => {
    const candles = upCandles(RED_622, { open: 660, high: 672, low: 655, close: 665 });
    const h = bearishHaramiHigh.evaluate(candles, candles.length - 1, undefined as never);
    expect(h).not.toBeNull();
    expect(h!.type).toBe('WATCH');
  });

  it('破底貫穿：收盤跌破昨日最低 → SELL（一路向下）', () => {
    const candles = upCandles(RED_622, { open: 680, high: 683, low: 628, close: 630 }); // 630 < 昨低 635
    const r = bearishPiercingHigh.evaluate(candles, candles.length - 1, undefined as never);
    expect(r).not.toBeNull();
    expect(r!.type).toBe('SELL');
    expect(r!.label).toContain('破底');
  });

  it('破實體未破昨低且未被整根包住 → WATCH 次日確認', () => {
    // low 634 破昨日下影範圍（未被包住）、close 641 未破昨低 635
    const candles = upCandles(RED_622, { open: 680, high: 683, low: 634, close: 641 });
    const r = bearishPiercingHigh.evaluate(candles, candles.length - 1, undefined as never);
    expect(r).not.toBeNull();
    expect(r!.type).toBe('WATCH');
    expect(r!.label).toContain('次日確認');
  });

  it('開高+收破昨開（吞噬幾何）→ 貫穿讓位、吞噬規則 SELL', () => {
    const candles = upCandles(RED_622, { open: 692, high: 693, low: 638, close: 640 });
    const p = bearishPiercingHigh.evaluate(candles, candles.length - 1, undefined as never);
    expect(p).toBeNull();
    const e = bearishEngulfingHigh.evaluate(candles, candles.length - 1, undefined as never);
    expect(e).not.toBeNull();
    expect(e!.type).toBe('SELL');
  });

  it('沒破紅K實體 → 貫穿 null（覆蓋/遭遇族接手）', () => {
    const candles = upCandles(RED_622, { open: 685, high: 688, low: 650, close: 655 });
    expect(bearishPiercingHigh.evaluate(candles, candles.length - 1, undefined as never)).toBeNull();
  });
});

describe('低檔：課程 CH2-7 六組判準（鏡像）', () => {
  const BLACK = { open: 590, high: 595, low: 540, close: 542 }; // 長黑（收最低附近）

  it('長紅整根被黑K包住 → 母子懷抱（光明在望）WATCH，貫穿讓位', () => {
    const candles = downCandles(BLACK, { open: 545, high: 593, low: 543, close: 592 }); // 長紅 +8.6% 被包住
    const h = bullishHaramiLow.evaluate(candles, candles.length - 1, undefined as never);
    expect(h).not.toBeNull();
    expect(h!.type).toBe('WATCH');
    expect(bullishPiercingLow.evaluate(candles, candles.length - 1, undefined as never)).toBeNull();
  });

  it('破高貫穿：收盤突破昨日最高 → BUY（一路向上）', () => {
    const candles = downCandles(BLACK, { open: 545, high: 600, low: 543, close: 598 }); // 598 > 昨高 595
    const r = bullishPiercingLow.evaluate(candles, candles.length - 1, undefined as never);
    expect(r).not.toBeNull();
    expect(r!.type).toBe('BUY');
    expect(r!.label).toContain('破高');
  });

  it('破實體未破昨高且未被包住 → WATCH 次日確認（不再誤發 BUY）', () => {
    // high 596 過昨上影？596 > 595 → 沒被包住 ✓；close 592 < 昨高 595 未破高；close 592 ≥ 昨開 590 破實體
    const candles = downCandles(BLACK, { open: 550, high: 596, low: 545, close: 592 });
    const r = bullishPiercingLow.evaluate(candles, candles.length - 1, undefined as never);
    expect(r).not.toBeNull();
    expect(r!.type).toBe('WATCH');
  });
});
