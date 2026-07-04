/**
 * 課程 CH9-3(二)(三)（2026-07-04）：爆量反轉「獲利>15% 先停利1/2、次日下跌全出」advisory
 *
 * detectKBarExitSignal 新分支：
 *   - 訊號日：爆大量長黑吞噬/長上影、未破前日低、獲利 >15% → advisory 'partial-tp-half'
 *   - 次日：昨日為訊號日（重算，path-independent）且今日下跌 → advisory 'exit-remaining'
 */
import { describe, it, expect } from '@jest/globals';
import { detectKBarExitSignal } from '@/lib/sell/v12TakeProfit';
import type { CandleWithIndicators } from '@/types';

function bar(p: Partial<CandleWithIndicators> & { open: number; high: number; low: number; close: number }): CandleWithIndicators {
  return { date: '2026-07-04', volume: 10000, ...p } as CandleWithIndicators;
}

// 昨日：一般紅 K
const redYesterday = bar({ open: 100, high: 105.5, low: 99.5, close: 105 });
// 今日：爆量長上影（上影 88% 全長）、收盤未破昨低
const upperShadowToday = bar({ open: 104, high: 118, low: 103, close: 106, volume: 30000, avgVol5: 10000 });

describe('detectKBarExitSignal — CH9-3 分批停利 advisory', () => {
  it('訊號日：爆量長上影未破昨低 + 獲利 18% → partial-tp-half（triggered=false）', () => {
    const r = detectKBarExitSignal({
      todayCandle: upperShadowToday,
      yesterdayCandle: redYesterday,
      cumulativeProfit: 0.18,
    });
    expect(r.triggered).toBe(false);
    expect(r.advisory).toBe('partial-tp-half');
    expect(r.sellFraction).toBe(0.5);
    expect(r.detail).toContain('15%');
  });

  it('獲利只有 12%（未達 15%）→ 無 advisory', () => {
    const r = detectKBarExitSignal({
      todayCandle: upperShadowToday,
      yesterdayCandle: redYesterday,
      cumulativeProfit: 0.12,
    });
    expect(r.advisory).toBeUndefined();
  });

  it('量不足（非爆量）→ 無 advisory', () => {
    const noVol = bar({ ...upperShadowToday, volume: 12000, avgVol5: 10000 });
    const r = detectKBarExitSignal({
      todayCandle: noVol,
      yesterdayCandle: redYesterday,
      cumulativeProfit: 0.18,
    });
    expect(r.advisory).toBeUndefined();
  });

  it('爆量長黑吞噬 → 當天全出（triggered，2026-07-05 課程口徑：吞噬不走1/2）', () => {
    const yest = bar({ open: 103, high: 106.5, low: 99, close: 106 }); // 紅 K、低點壓低
    const engulfToday = bar({ open: 107, high: 107.5, low: 101.5, close: 102, volume: 30000, avgVol5: 10000 }); // 吞噬但 close 102 ≥ 昨低 99
    const r = detectKBarExitSignal({
      todayCandle: engulfToday,
      yesterdayCandle: yest,
      cumulativeProfit: 0.2,
    });
    expect(r.advisory).toBeUndefined();       // 不再被 1/2 advisory 攔截
    expect(r.triggered).toBe(true);           // 落回 bearish-engulfing 全出
    expect(r.signalType).toBe('bearish-engulfing');
  });

  it('爆量長黑（非吞噬）未破昨低 + 獲利>15% → partial-tp-half（CH8-3(6) long-black 型）', () => {
    const yest = bar({ open: 100, high: 105.5, low: 99.5, close: 105 });
    const longBlackToday = bar({ open: 104.5, high: 105, low: 100.5, close: 101, volume: 30000, avgVol5: 10000 }); // 黑實體 3.3%、未破昨低、開低（非吞噬）
    const r = detectKBarExitSignal({
      todayCandle: longBlackToday,
      yesterdayCandle: yest,
      cumulativeProfit: 0.18,
    });
    expect(r.advisory).toBe('partial-tp-half');
    expect(r.detail).toContain('爆量長黑');
  });

  it('已跌破昨日低點 → 不走 advisory（落入既有整批出場訊號）', () => {
    const yest = bar({ open: 100, high: 105.5, low: 99.5, close: 105 });
    const breakLow = bar({ open: 106, high: 106.5, low: 98, close: 98.5, volume: 30000, avgVol5: 10000 });
    const r = detectKBarExitSignal({
      todayCandle: breakLow,
      yesterdayCandle: yest,
      cumulativeProfit: 0.18,
    });
    expect(r.advisory).toBeUndefined();
    expect(r.triggered).toBe(true); // 穿心黑（跌破昨日紅K 1/2 + 昨低）
  });

  it('次日：昨日為訊號日 + 今日下跌 → exit-remaining（用昨日獲利判 15%）', () => {
    const dayAfter = bar({ open: 105, high: 106, low: 102.5, close: 103 }); // 今日下跌（103 < 106）
    const r = detectKBarExitSignal({
      todayCandle: dayAfter,
      yesterdayCandle: upperShadowToday,      // 昨日 = 訊號日
      twoDaysAgoCandle: redYesterday,
      cumulativeProfit: 0.13,                 // 今日回落後已 <15%
      yesterdayCumulativeProfit: 0.18,        // 但訊號日 >15% → 仍該全出
    });
    expect(r.triggered).toBe(false);
    expect(r.advisory).toBe('exit-remaining');
    expect(r.sellFraction).toBe(1);
  });

  it('次日上漲 → 不觸發 exit-remaining（續抱）', () => {
    const dayAfterUp = bar({ open: 106, high: 109, low: 105.5, close: 108.5 });
    const r = detectKBarExitSignal({
      todayCandle: dayAfterUp,
      yesterdayCandle: upperShadowToday,
      twoDaysAgoCandle: redYesterday,
      cumulativeProfit: 0.2,
      yesterdayCumulativeProfit: 0.18,
    });
    expect(r.advisory).toBeUndefined();
  });
});
