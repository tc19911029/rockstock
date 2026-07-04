/**
 * lib/portfolio/trappedTier.ts — 課程 CH10-1 套牢分級 + 反彈遇壓不漲（2026-07-04）
 *
 * 覆蓋：
 *  - classifyTrappedTier 三級邊界
 *  - detectReboundStallAtResistance 三條件（反彈成立 / 觸壓 / 不漲確認）各自的正反例
 *  - buildTrappedSignals 對應訊號型別
 */
import { describe, it, expect } from '@jest/globals';
import {
  classifyTrappedTier,
  detectReboundStallAtResistance,
  buildTrappedSignals,
} from '@/lib/portfolio/trappedTier';
import type { Candle } from '@/types';

function makeCandles(closes: number[]): Candle[] {
  const start = new Date('2026-01-01');
  return closes.map((c, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return { date: d.toISOString().slice(0, 10), open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 10000 };
  });
}

/** 跌 → 反彈觸 MA20 被壓回 → 3 日不創新高 的標準劇本 */
function stallScenario(): Candle[] {
  const closes = [
    ...Array.from({ length: 20 }, () => 100), // 高檔盤整（撐高 MA20）
    96, 92, 88, 84, 80,                       // 下跌段
    84, 89, 93.5,                             // 反彈段（93.5 觸 MA20≈95.3 ×0.98 被壓回）
    90, 89, 88,                               // 觸壓後 3 日未創反彈新高
  ];
  return makeCandles(closes);
}

describe('classifyTrappedTier', () => {
  it('賠損 ≤10% 不算套牢', () => {
    expect(classifyTrappedTier(-0.05)).toBe('none');
    expect(classifyTrappedTier(-0.099)).toBe('none');
    expect(classifyTrappedTier(0.10)).toBe('none');
  });
  it('賠損 10~20% → trapped_10_20', () => {
    expect(classifyTrappedTier(-0.10)).toBe('trapped_10_20');
    expect(classifyTrappedTier(-0.15)).toBe('trapped_10_20');
    expect(classifyTrappedTier(-0.199)).toBe('trapped_10_20');
  });
  it('賠損 >20% → trapped_over_20', () => {
    expect(classifyTrappedTier(-0.20)).toBe('trapped_over_20');
    expect(classifyTrappedTier(-0.35)).toBe('trapped_over_20');
  });
});

describe('detectReboundStallAtResistance', () => {
  it('標準劇本：反彈觸 MA20 被壓回 + 3 日不創新高 → stalled', () => {
    const r = detectReboundStallAtResistance(stallScenario());
    expect(r.stalled).toBe(true);
    expect(r.detail).toContain('MA20');
  });

  it('K 線不足 → 不觸發', () => {
    const r = detectReboundStallAtResistance(makeCandles([100, 95, 90]));
    expect(r.stalled).toBe(false);
  });

  it('一路下跌沒反彈 → 不觸發（反彈未成立）', () => {
    const closes = Array.from({ length: 31 }, (_, i) => 100 - i * 1.5);
    const r = detectReboundStallAtResistance(makeCandles(closes));
    expect(r.stalled).toBe(false);
  });

  it('反彈中但尚未觸壓（離 MA20 還遠）→ 不觸發', () => {
    const closes = [
      ...Array.from({ length: 20 }, () => 100),
      92, 84, 76, 70, 66,   // 深跌，MA20 遠在上方
      68, 70, 71,           // 小反彈，離 MA20 很遠
    ];
    const r = detectReboundStallAtResistance(makeCandles(closes));
    expect(r.stalled).toBe(false);
  });

  it('觸壓後又創反彈新高 → 不觸發（反彈未死）', () => {
    const closes = [
      ...Array.from({ length: 20 }, () => 100),
      96, 92, 88, 84, 80,
      84, 89, 93.5,         // 觸壓
      95, 96, 97,           // 卻繼續創反彈新高
    ];
    const r = detectReboundStallAtResistance(makeCandles(closes));
    expect(r.stalled).toBe(false);
  });

  it('觸壓後天數不足 3 日 → 觀察中不觸發', () => {
    const closes = [
      ...Array.from({ length: 20 }, () => 100),
      96, 92, 88, 84, 80,
      84, 89, 93.5,         // 觸壓日
      90,                   // 才 1 日
    ];
    const r = detectReboundStallAtResistance(makeCandles(closes));
    expect(r.stalled).toBe(false);
  });
});

describe('buildTrappedSignals', () => {
  it('賠損 <10% → 空陣列', () => {
    expect(buildTrappedSignals(-0.08, stallScenario())).toEqual([]);
  });

  it('賠損 10-20% + 反彈遇壓 → trapped_rebound_stall（high）', () => {
    const sigs = buildTrappedSignals(-0.15, stallScenario());
    expect(sigs).toHaveLength(1);
    expect(sigs[0].type).toBe('trapped_rebound_stall');
    expect(sigs[0].severity).toBe('high');
  });

  it('賠損 10-20% 無反彈遇壓 → trapped_flag（medium）', () => {
    const closes = Array.from({ length: 31 }, (_, i) => 100 - i * 0.5); // 陰跌沒反彈
    const sigs = buildTrappedSignals(-0.12, makeCandles(closes));
    expect(sigs).toHaveLength(1);
    expect(sigs[0].type).toBe('trapped_flag');
    expect(sigs[0].severity).toBe('medium');
  });

  it('賠損 >20% → trapped_deep_three_paths（三條路文案）', () => {
    const sigs = buildTrappedSignals(-0.25, stallScenario());
    expect(sigs).toHaveLength(1);
    expect(sigs[0].type).toBe('trapped_deep_three_paths');
    expect(sigs[0].detail).toContain('反手做空');
    expect(sigs[0].detail).toContain('加碼');
  });
});
