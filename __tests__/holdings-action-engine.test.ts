/**
 * lib/agents/holdingsActionEngine.ts
 *
 * 書本訊號分派（優先順序）：
 *   1. today ≤ stopLoss            → stop_loss
 *   2. 跌破 MA20 + 漲幅 ≥ 20%        → exit_all（長線停利）
 *   3. 跌破 MA10 + 漲幅 ≥ 10%        → exit_all（中線停利）
 *   4. 跌破 MA5 + 漲幅 ≥ 10%         → reduce_half（短線停利）
 *   5. 距停損 < 3%                   → watch_stop
 *   6. entryGate=can_enter + 上 MA20 → can_add
 *   7. default                       → hold
 */

import { evaluateHolding } from '@/lib/agents/holdingsActionEngine';
import type { Candle } from '@/types';

function makeCandles(closes: number[]): Candle[] {
  const start = new Date('2026-01-01');
  return closes.map((c, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return { date: d.toISOString().slice(0, 10), open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 10000 };
  });
}

describe('evaluateHolding', () => {
  it('today ≤ stopLoss → stop_loss', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 95, candles, todayClose: 94 });
    expect(r.action).toBe('stop_loss');
    expect(r.signals[0].type).toBe('absolute_stop');
  });

  it('跌破 MA10 + 漲幅 ≥ 10% → exit_all（中線停利）', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 1.0);
    const today = 113;
    closes.push(today);
    const candles = makeCandles(closes);
    const ma10 = candles.slice(-10).reduce((a, c) => a + c.close, 0) / 10;
    expect(today).toBeLessThan(ma10);
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 90, candles, todayClose: today });
    expect(r.action).toBe('exit_all');
    expect(r.signals.some(s => s.type === 'break_ma10_mid')).toBe(true);
    expect(r.profitPct).toBeCloseTo(0.13, 2);
  });

  it('跌破 MA20 + 漲幅 ≥ 20% → exit_all（長線停利）', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 1.5);
    const today = 122;
    closes.push(today);
    const candles = makeCandles(closes);
    const ma20 = candles.slice(-20).reduce((a, c) => a + c.close, 0) / 20;
    expect(today).toBeLessThan(ma20);
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 90, candles, todayClose: today });
    expect(r.action).toBe('exit_all');
    expect(r.signals.some(s => s.type === 'break_ma20_long')).toBe(true);
  });

  it('跌破 MA5 + 漲幅 ≥ 10% (但 MA10 不破) → reduce_half', () => {
    const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
                    100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
                    100, 100, 100, 100, 105, 110, 115, 120, 125, 130];
    closes.push(120);
    const candles = makeCandles(closes);
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 95, candles, todayClose: 120 });
    expect(r.action).toBe('reduce_half');
    expect(r.signals.some(s => s.type === 'break_ma5_short')).toBe(true);
  });

  it('距停損 < 3% → watch_stop', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 99, candles, todayClose: 101 });
    expect(r.action).toBe('watch_stop');
  });

  it('回測 MA5 不破 + 漲幅 < 10% → can_add', () => {
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + i * 0.1);
    closes.push(closes[closes.length - 1] * 1.02);
    const ma5Recent = (closes.slice(-5).reduce((a, b) => a + b, 0)) / 5;
    closes[closes.length - 1] = ma5Recent;
    const candles = makeCandles(closes);
    const today = closes[closes.length - 1];
    const r = evaluateHolding({ symbol: 'T', entryPrice: today * 0.97, stopLoss: today * 0.92, candles, todayClose: today });
    expect(r.action).toBe('can_add');
    expect(r.profitPct).toBeLessThan(0.10);
    expect(r.signals.some(s => s.type === 'pullback_ma5_ok')).toBe(true);
  });

  it('回測 MA5 不破但漲幅 ≥ 10% → hold（已過加碼點，不追高拉成本）', () => {
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + i * 0.1);
    closes.push(closes[closes.length - 1] * 1.02);
    const ma5Recent = (closes.slice(-5).reduce((a, b) => a + b, 0)) / 5;
    closes[closes.length - 1] = ma5Recent;
    const candles = makeCandles(closes);
    const today = closes[closes.length - 1];
    const r = evaluateHolding({ symbol: 'T', entryPrice: today * 0.7, stopLoss: today * 0.65, candles, todayClose: today });
    expect(r.action).toBe('hold');
    expect(r.profitPct).toBeGreaterThanOrEqual(0.10);
    expect(r.signals.some(s => s.type === 'past_add_zone')).toBe(true);
  });

  it('賺 12%、未跌破任何均線、距 MA5 > 3% → hold + 停損上移到 MA10-0.5%', () => {
    const closes = Array.from({ length: 30 }, () => 100);
    closes.push(112);
    const candles = makeCandles(closes);
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 95, candles, todayClose: 112 });
    expect(r.action).toBe('hold');
    expect(r.suggestedStop).toBeGreaterThan(95);
    expect(r.metrics.ma10).not.toBeNull();
    expect(r.suggestedStop).toBeCloseTo(r.metrics.ma10! * 0.995, 1);
  });

  it('賺 25%、未破任何均線 → hold + 停損上移到 MA20-0.5%（鎖長線）', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    const today = 130;
    closes.push(today);
    const candles = makeCandles(closes);
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 95, candles, todayClose: today });
    expect(['hold', 'can_add']).toContain(r.action);
    expect(r.suggestedStop).toBeGreaterThan(95);
    expect(r.suggestedStop).toBeCloseTo(r.metrics.ma20! * 0.995, 0);
  });

  it('停損優先於停利訊號（跌破停損即使 MA 看似 OK）', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 105, candles, todayClose: 100 });
    expect(r.action).toBe('stop_loss');
  });
});
