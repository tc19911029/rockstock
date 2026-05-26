/**
 * lib/agents/entryGate.ts — 進場時機 gate（書本規則）
 *
 * 規則來源：
 * - 連 2 漲停 → no_chase（朱書「漲停板隔日是危險區」）
 * - 月線乖離 > 15% → no_chase（[zhu_book_audit] 末升段條件之一）
 * - 季線乖離 > 25% → no_chase
 * - 末升段三條件（連 3 長紅 + 暴量 + 月線乖離 > 15%） → no_chase
 * - 回測 MA5 不破（在 MA5 ±2% 內且 close >= MA5 - 0.5%） → can_enter
 * - 其他 → watch
 */

import { computeEntryState, entryStateLabel } from '@/lib/agents/entryGate';
import type { Candle } from '@/types';

function makeCandles(closes: number[], opts: { volumes?: number[]; startDate?: string } = {}): Candle[] {
  const { volumes, startDate = '2026-01-01' } = opts;
  const start = new Date(startDate);
  return closes.map((c, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return {
      date: d.toISOString().slice(0, 10),
      open: c,
      high: c * 1.005,
      low: c * 0.995,
      close: c,
      volume: volumes?.[i] ?? 10000,
    };
  });
}

describe('computeEntryState', () => {
  it('資料不足回 watch', () => {
    const result = computeEntryState({ symbol: 'TEST', candles: [] });
    expect(result.state).toBe('watch');
    expect(result.reasons[0]).toMatch(/不足/);
  });

  it('連 2 漲停 → no_chase', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    closes.push(closes[closes.length - 1] * 1.10);
    closes.push(closes[closes.length - 1] * 1.10);
    const result = computeEntryState({ symbol: 'TEST', candles: makeCandles(closes) });
    expect(result.state).toBe('no_chase');
    expect(result.reasons.some(r => r.includes('連 2 漲停'))).toBe(true);
    expect(result.metrics.consecutiveLimitUp).toBe(2);
  });

  it('單根漲停不觸發 no_chase（連續=1）', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    closes.push(closes[closes.length - 1] * 1.10);
    const result = computeEntryState({ symbol: 'TEST', candles: makeCandles(closes) });
    expect(result.metrics.consecutiveLimitUp).toBe(1);
    expect(result.state).not.toBe('no_chase');
  });

  it('月線乖離 > 15% → no_chase', () => {
    const closes = Array.from({ length: 60 }, () => 100);
    closes.push(120);
    const result = computeEntryState({ symbol: 'TEST', candles: makeCandles(closes) });
    expect(result.state).toBe('no_chase');
    expect(result.reasons.some(r => r.includes('月線乖離'))).toBe(true);
    expect(result.metrics.deviationMa20!).toBeGreaterThan(0.15);
  });

  it('季線乖離 > 25% → no_chase', () => {
    const closes = Array.from({ length: 60 }, () => 100);
    closes.push(135);
    const result = computeEntryState({ symbol: 'TEST', candles: makeCandles(closes) });
    expect(result.state).toBe('no_chase');
    expect(result.reasons.some(r => r.includes('季線乖離'))).toBe(true);
    expect(result.metrics.deviationMa60!).toBeGreaterThan(0.25);
  });

  it('回測 MA5 不破 → can_enter', () => {
    const base = 100;
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(base + i * 0.1);
    closes.push(closes[closes.length - 1] * 1.02);
    closes.push(closes[closes.length - 1] * 1.02);
    const ma5Recent = (closes.slice(-5).reduce((a, b) => a + b, 0)) / 5;
    closes[closes.length - 1] = ma5Recent;
    const result = computeEntryState({ symbol: 'TEST', candles: makeCandles(closes) });
    expect(result.state).toBe('can_enter');
    expect(result.reasons.some(r => r.includes('回測 MA5'))).toBe(true);
  });

  it('收盤明顯偏離 MA5（跌破） → 不算 can_enter', () => {
    const closes = Array.from({ length: 30 }, () => 100);
    closes.push(95);
    const result = computeEntryState({ symbol: 'TEST', candles: makeCandles(closes) });
    expect(result.state).not.toBe('can_enter');
    expect(result.metrics.distanceToMa5!).toBeLessThan(-0.02);
  });

  it('末升段三條件（連 3 長紅 + 暴量 + 乖離 > 15%）→ no_chase', () => {
    const closes: number[] = Array.from({ length: 30 }, () => 100);
    const vols: number[] = Array.from({ length: 30 }, () => 10000);
    let last = 100;
    for (let i = 0; i < 3; i++) {
      last = last * 1.07;
      closes.push(last);
      vols.push(30000);
    }
    const result = computeEntryState({
      symbol: 'TEST',
      candles: makeCandles(closes, { volumes: vols }),
    });
    expect(result.state).toBe('no_chase');
    expect(result.metrics.isLateStageThird).toBe(true);
    expect(result.reasons.some(r => r.includes('末升段'))).toBe(true);
  });

  it('小漲一根但已偏離 MA5 > 2% → watch（不是 can_enter 也不是 no_chase）', () => {
    const closes = Array.from({ length: 30 }, () => 100);
    closes.push(104);
    const result = computeEntryState({ symbol: 'TEST', candles: makeCandles(closes) });
    expect(result.state).toBe('watch');
    expect(result.metrics.consecutiveLimitUp).toBe(0);
    expect(result.metrics.deviationMa20!).toBeLessThan(0.15);
  });

  it('no_chase 優先於 can_enter（即使在 MA5 附近，連 2 漲停也擋）', () => {
    const closes = Array.from({ length: 30 }, () => 100);
    closes.push(110);
    closes.push(121);
    const result = computeEntryState({ symbol: 'TEST', candles: makeCandles(closes) });
    expect(result.state).toBe('no_chase');
  });
});

describe('entryStateLabel', () => {
  it('回傳中文 label', () => {
    expect(entryStateLabel('can_enter')).toBe('可進');
    expect(entryStateLabel('watch')).toBe('觀望');
    expect(entryStateLabel('no_chase')).toBe('不可追');
  });
});
