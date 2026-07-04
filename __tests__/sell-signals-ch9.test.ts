/**
 * sellSignals — 課程 CH9-3(一)「跌破高檔連續兩日大量 K 線低點」（2026-07-04）
 *
 * 覆蓋：正例 / 量不足 / 事件型 dedup（已破不重報）/ 非高檔 gate。
 */
import { describe, it, expect } from '@jest/globals';
import { detectSellSignals } from '@/lib/analysis/sellSignals';
import { computeIndicators } from '@/lib/indicators';
import type { Candle } from '@/types';

interface Bar { close: number; volume?: number }

function makeCandles(bars: Bar[]): Candle[] {
  const start = new Date('2026-01-01');
  return bars.map((b, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const prevClose = i > 0 ? bars[i - 1].close : b.close;
    return {
      date: d.toISOString().slice(0, 10),
      open: prevClose,
      high: Math.max(prevClose, b.close) * 1.005,
      low: Math.min(prevClose, b.close) * 0.995,
      close: b.close,
      volume: b.volume ?? 10000,
    };
  });
}

/** 上升趨勢 + 高檔連兩日爆量 + 今日首次跌破兩日大量低點 */
function baseScenario(pairVol = 30000): Bar[] {
  const bars: Bar[] = Array.from({ length: 27 }, (_, i) => ({ close: 100 + i * 0.5 }));
  // index 27, 28：連續兩日爆大量（收盤續漲）
  bars.push({ close: 113.5, volume: pairVol });
  bars.push({ close: 114, volume: pairVol });
  // index 29：還沒破
  bars.push({ close: 114.5 });
  // index 30（今日）：收盤跌破兩日大量低點（≈112.93）
  bars.push({ close: 112 });
  return bars;
}

describe('HIGH_VOL_2DAY_LOW_BREAK — 課程 CH9-3(一)', () => {
  it('高檔連兩日爆量 + 今日首次跌破其低點 → 觸發（severity high）', () => {
    const candles = computeIndicators(makeCandles(baseScenario()));
    const sigs = detectSellSignals(candles, candles.length - 1);
    const hit = sigs.find(s => s.type === 'HIGH_VOL_2DAY_LOW_BREAK');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
    expect(hit!.detail).toContain('CH9-3');
  });

  it('量不足（非爆量）→ 不觸發', () => {
    const candles = computeIndicators(makeCandles(baseScenario(12000)));
    const sigs = detectSellSignals(candles, candles.length - 1);
    expect(sigs.some(s => s.type === 'HIGH_VOL_2DAY_LOW_BREAK')).toBe(false);
  });

  it('昨日已破今日續跌 → 不重複報（事件型 dedup）', () => {
    const bars = baseScenario();
    bars.push({ close: 111 }); // 今日續跌（首次跌破發生在昨日）
    const candles = computeIndicators(makeCandles(bars));
    const sigs = detectSellSignals(candles, candles.length - 1);
    expect(sigs.some(s => s.type === 'HIGH_VOL_2DAY_LOW_BREAK')).toBe(false);
  });

  it('非高檔（空頭 ma5<ma20）→ 不觸發', () => {
    const bars: Bar[] = Array.from({ length: 27 }, (_, i) => ({ close: 130 - i * 0.8 }));
    bars.push({ close: 108, volume: 30000 });
    bars.push({ close: 107.5, volume: 30000 });
    bars.push({ close: 107 });
    bars.push({ close: 104 }); // 跌破兩日大量低點但趨勢空頭
    const candles = computeIndicators(makeCandles(bars));
    const sigs = detectSellSignals(candles, candles.length - 1);
    expect(sigs.some(s => s.type === 'HIGH_VOL_2DAY_LOW_BREAK')).toBe(false);
  });

  it('僅單日爆量（非連續兩日）→ 不觸發', () => {
    const bars: Bar[] = Array.from({ length: 27 }, (_, i) => ({ close: 100 + i * 0.5 }));
    bars.push({ close: 113.5, volume: 30000 }); // 只有一日爆量
    bars.push({ close: 114 });
    bars.push({ close: 114.5 });
    bars.push({ close: 112 });
    const candles = computeIndicators(makeCandles(bars));
    const sigs = detectSellSignals(candles, candles.length - 1);
    expect(sigs.some(s => s.type === 'HIGH_VOL_2DAY_LOW_BREAK')).toBe(false);
  });
});
