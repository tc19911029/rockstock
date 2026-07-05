// 捕撈金叉/死叉觸發價 — 一致性測試：
// 顯示的觸發價「真的會觸發」（收在觸發價 → CROSS 成立），且「差一分錢就不會」（臨界另一側 → 不成立）。
import { computeCatchCrossTrigger } from '@/lib/cn-sanse/crossTrigger';
import { computeXys } from '@/lib/cn-sanse/dualB';
import type { Candle } from '@/types';

/** 決定性合成日K：base 走勢 + 小振幅，收斂可控（不用隨機數）。 */
function mkCandles(closes: number[]): Candle[] {
  return closes.map((c, k) => ({
    date: `2026-01-${String((k % 28) + 1).padStart(2, '0')}`,
    open: c * 0.995,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: 1_000_000,
  }));
}

/** 把最後一根收盤假設成 P（高低點跟著外擴），回傳當根金叉/死叉布林。 */
function simulateAt(candles: Candle[], P: number): { gold: boolean; dead: boolean } {
  const i = candles.length - 1;
  const last = candles[i];
  const sim = candles.slice(0, i).concat([{ ...last, close: P, high: Math.max(last.high, P), low: Math.min(last.low, P) }]);
  const x = computeXys(sim);
  return { gold: !!x.goldCross[i], dead: !!x.deadCross[i] };
}

describe('computeCatchCrossTrigger', () => {
  test('資料不足回 null', () => {
    expect(computeCatchCrossTrigger(mkCandles(Array.from({ length: 20 }, () => 100)))).toBeNull();
  });

  test('金叉側：觸發價收盤會金叉、低一分錢不會', () => {
    // 快慢線是「動能」：快<慢＝動能在降。用「上漲但漲幅遞減」→ 昨日快<慢 → 今天只可能金叉
    const closes: number[] = [100];
    let gain = 2.0;
    for (let k = 0; k < 70; k++) { closes.push(closes[closes.length - 1] + gain); gain *= 0.9; }
    const candles = mkCandles(closes);
    const t = computeCatchCrossTrigger(candles, 0.10);
    expect(t).not.toBeNull();
    expect(t!.side).toBe('gold');
    if (t!.price != null && !t!.always && t!.reachable) {
      expect(simulateAt(candles, t!.price).gold).toBe(true);
      expect(simulateAt(candles, t!.price - 0.01).gold).toBe(false);
    }
  });

  test('死叉側：觸發價收盤會死叉、高一分錢不會', () => {
    // 快>慢＝動能在升。用「下跌但跌幅收斂」→ 昨日快>慢 → 今天只可能死叉
    const closes: number[] = [130];
    let drop = 2.0;
    for (let k = 0; k < 70; k++) { closes.push(closes[closes.length - 1] - drop); drop *= 0.9; }
    const candles = mkCandles(closes);
    const t = computeCatchCrossTrigger(candles, 0.10);
    expect(t).not.toBeNull();
    expect(t!.side).toBe('dead');
    if (t!.price != null && !t!.always && t!.reachable) {
      expect(simulateAt(candles, t!.price).dead).toBe(true);
      expect(simulateAt(candles, t!.price + 0.01).dead).toBe(false);
    }
  });

  test('觸發價在漲跌停範圍內才 reachable', () => {
    const closes: number[] = [100];
    let gain = 2.0;
    for (let k = 0; k < 70; k++) { closes.push(closes[closes.length - 1] + gain); gain *= 0.9; }
    const candles = mkCandles(closes);
    const t = computeCatchCrossTrigger(candles, 0.10);
    if (t && t.price != null && t.reachable) {
      const prevClose = candles[candles.length - 2].close;
      expect(t.price).toBeGreaterThanOrEqual(prevClose * 0.9 - 1e-6);
      expect(t.price).toBeLessThanOrEqual(prevClose * 1.1 + 1e-6);
    }
  });
});
