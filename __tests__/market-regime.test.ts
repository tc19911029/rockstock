/**
 * lib/agents/marketRegime.ts — 大盤 regime 判斷
 *
 * 強多頭判定：close > MA20 + close > MA60 + MA20 > MA60 + 近 5 日漲幅 > 3%
 * 空頭：close < MA20 + MA20 < MA60
 * 其他：normal
 */

import { detectMarketRegime, thresholdsForRegime, regimeLabel } from '@/lib/agents/marketRegime';
import {
  ENTRY_GATE_THRESHOLDS,
  ENTRY_GATE_THRESHOLDS_STRONG_BULL,
  computeEntryState,
} from '@/lib/agents/entryGate';
import type { Candle } from '@/types';

function makeCandles(closes: number[]): Candle[] {
  const start = new Date('2026-01-01');
  return closes.map((c, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return {
      date: d.toISOString().slice(0, 10),
      open: c, high: c * 1.005, low: c * 0.995, close: c,
      volume: 10000,
    };
  });
}

describe('detectMarketRegime', () => {
  it('資料不足 → normal + 不足 reason', () => {
    const r = detectMarketRegime(makeCandles([100, 101, 102]));
    expect(r.regime).toBe('normal');
    expect(r.reasons[0]).toMatch(/不足/);
  });

  it('強多頭：close > MA20/MA60 + 5 日 +3% 以上 + MA20 > MA60', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    closes.push(closes[closes.length - 1] * 1.05);
    const r = detectMarketRegime(makeCandles(closes));
    expect(r.regime).toBe('strong_bull');
    expect(r.metrics.fiveDayReturn!).toBeGreaterThan(0.03);
    expect(r.metrics.closeVsMa20!).toBeGreaterThan(0);
    expect(r.metrics.ma20VsMa60!).toBeGreaterThan(0);
  });

  it('盤整：在 MA20 上方但 5 日漲幅 < 3% → normal', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.1);
    const r = detectMarketRegime(makeCandles(closes));
    expect(r.regime).toBe('normal');
    expect(r.metrics.fiveDayReturn!).toBeLessThan(0.03);
  });

  it('空頭：close < MA20 + MA20 < MA60', () => {
    const closes: number[] = [];
    for (let i = 0; i < 60; i++) closes.push(100 - i * 0.3);
    const r = detectMarketRegime(makeCandles(closes));
    expect(r.regime).toBe('bear');
    expect(r.metrics.closeVsMa20!).toBeLessThan(0);
    expect(r.metrics.ma20VsMa60!).toBeLessThan(0);
  });
});

describe('thresholdsForRegime', () => {
  it('strong_bull → 放寬閾值', () => {
    const t = thresholdsForRegime('strong_bull');
    expect(t).toBe(ENTRY_GATE_THRESHOLDS_STRONG_BULL);
    expect(t.consecutiveLimitUpNoChase).toBe(3);
    expect(t.ma20DeviationNoChase).toBe(0.25);
    expect(t.ma60DeviationNoChase).toBe(0.40);
  });

  it('normal / bear → 用 default 閾值', () => {
    expect(thresholdsForRegime('normal')).toBe(ENTRY_GATE_THRESHOLDS);
    expect(thresholdsForRegime('bear')).toBe(ENTRY_GATE_THRESHOLDS);
  });
});

describe('regime integration with entryGate', () => {
  it('連 2 漲停股票：normal regime → no_chase；strong_bull → 不擋（連 3 才擋）', () => {
    const closes = Array.from({ length: 30 }, () => 100);
    closes.push(110);
    closes.push(121);
    const candles = makeCandles(closes);
    const normalResult = computeEntryState({
      symbol: 'TEST', candles,
      thresholds: thresholdsForRegime('normal'),
    });
    const bullResult = computeEntryState({
      symbol: 'TEST', candles,
      thresholds: thresholdsForRegime('strong_bull'),
    });
    expect(normalResult.state).toBe('no_chase');
    expect(bullResult.state).not.toBe('no_chase');
  });

  it('月線乖離 +18%：normal → no_chase；strong_bull → 不擋（25% 才擋）', () => {
    const closes = Array.from({ length: 60 }, () => 100);
    closes.push(118);
    const candles = makeCandles(closes);
    const normalResult = computeEntryState({
      symbol: 'TEST', candles,
      thresholds: thresholdsForRegime('normal'),
    });
    const bullResult = computeEntryState({
      symbol: 'TEST', candles,
      thresholds: thresholdsForRegime('strong_bull'),
    });
    expect(normalResult.state).toBe('no_chase');
    expect(normalResult.reasons.some(r => r.includes('月線乖離'))).toBe(true);
    expect(bullResult.state).not.toBe('no_chase');
  });
});

describe('regimeLabel', () => {
  it('回傳中文', () => {
    expect(regimeLabel('strong_bull')).toBe('強多頭');
    expect(regimeLabel('normal')).toBe('盤整');
    expect(regimeLabel('bear')).toBe('空頭');
  });
});
