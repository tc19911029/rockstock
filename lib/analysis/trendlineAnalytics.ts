/**
 * 切線分析 — 書本 Part 5 p.348-393
 *
 * 實作：
 *   - 切線斜率強弱（p.368, p.373）
 *   - 支撐遞減權重（p.368: 1 次最強 > 2 次約 50% > 後面易破）
 *   - 上升/下降軌道線（與切線平行）+ 突破（p.252, p.387-393）
 */
import type { CandleWithIndicators } from '@/types';
import { findPivots } from './trendAnalysis';

export interface TrendlineInfo {
  p1: { index: number; price: number };
  p2: { index: number; price: number };
  slopePerDay: number;  // 每日價格變化
  currentLineValue: number;  // 延伸到當前 index 的切線值
}

/** 連接最近 2 個底底高低點 = 上升切線 */
export function getUpTrendline(
  candles: CandleWithIndicators[], index: number,
): TrendlineInfo | null {
  const pivots = findPivots(candles, index, 6);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (lows.length < 2) return null;
  const [latest, earlier] = lows;
  if (latest.price <= earlier.price) return null;  // 必須底底高
  const slopePerDay = (latest.price - earlier.price) / (latest.index - earlier.index);
  const currentLineValue = latest.price + slopePerDay * (index - latest.index);
  return {
    p1: { index: earlier.index, price: earlier.price },
    p2: { index: latest.index, price: latest.price },
    slopePerDay,
    currentLineValue,
  };
}

/** 下降切線（頭頭低的兩高點連線） */
export function getDownTrendline(
  candles: CandleWithIndicators[], index: number,
): TrendlineInfo | null {
  const pivots = findPivots(candles, index, 6);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  if (highs.length < 2) return null;
  const [latest, earlier] = highs;
  if (latest.price >= earlier.price) return null;
  const slopePerDay = (latest.price - earlier.price) / (latest.index - earlier.index);
  const currentLineValue = latest.price + slopePerDay * (index - latest.index);
  return {
    p1: { index: earlier.index, price: earlier.price },
    p2: { index: latest.index, price: latest.price },
    slopePerDay,
    currentLineValue,
  };
}

// ────────────────────────────────────────────────────────────────
// 切線斜率強弱（書本 p.368, p.373）
// 斜率越大 → 走勢越強；比較歷史段落的斜率變化
// ────────────────────────────────────────────────────────────────

export function trendlineSteepness(tl: TrendlineInfo): 'strong' | 'medium' | 'weak' {
  const pctPerDay = tl.slopePerDay / ((tl.p1.price + tl.p2.price) / 2);
  const abs = Math.abs(pctPerDay);
  if (abs > 0.01) return 'strong';    // 每天 >1%
  if (abs > 0.005) return 'medium';   // 0.5-1%
  return 'weak';
}

// ────────────────────────────────────────────────────────────────
// 支撐/壓力遞減權重（書本 p.368, p.372）
// 第 1 次最強（100%）> 第 2 次約 50% > 第 3 次及後低
// ────────────────────────────────────────────────────────────────

/** 一條切線被觸碰的次數（回測到切線 ±2% 內視為觸碰） */
export function trendlineTouchCount(
  candles: CandleWithIndicators[],
  tl: TrendlineInfo,
  endIndex: number,
): number {
  let count = 0;
  for (let j = tl.p2.index + 1; j <= endIndex; j++) {
    const lineValue = tl.p2.price + tl.slopePerDay * (j - tl.p2.index);
    const c = candles[j];
    if (!c) continue;
    // 對支撐：low 接近 lineValue（在 2% 內）
    if (Math.abs(c.low - lineValue) / lineValue < 0.02) count++;
  }
  return count;
}

/** 切線當下支撐強度（遞減） */
export function trendlineStrength(touchCount: number): number {
  // 書本 p.368：1 次最強、2 次約 50%、3 次及之後弱
  if (touchCount === 0) return 1.0;   // 第 1 次 = 100%
  if (touchCount === 1) return 0.5;   // 第 2 次 ≈ 50%
  return 0.2;                          // 之後易破
}

// ────────────────────────────────────────────────────────────────
// 上升/下降軌道線（書本 p.387-393）
// 與切線平行，在高/低點延伸出對等的另一條線
// ────────────────────────────────────────────────────────────────

/** 上升軌道線 = 上升切線向上平移到「切線之後的最高點」 */
export function getUpChannelLine(
  candles: CandleWithIndicators[], index: number,
): number | null {
  const tl = getUpTrendline(candles, index);
  if (!tl) return null;
  // 找 tl.p1~tl.p2 之間的最高點，算它離切線的距離
  let maxAbove = 0;
  for (let j = tl.p1.index; j <= tl.p2.index; j++) {
    const lineVal = tl.p1.price + tl.slopePerDay * (j - tl.p1.index);
    const diff = candles[j].high - lineVal;
    if (diff > maxAbove) maxAbove = diff;
  }
  return tl.currentLineValue + maxAbove;
}

/** 下降軌道線（鏡像） */
export function getDownChannelLine(
  candles: CandleWithIndicators[], index: number,
): number | null {
  const tl = getDownTrendline(candles, index);
  if (!tl) return null;
  let maxBelow = 0;
  for (let j = tl.p1.index; j <= tl.p2.index; j++) {
    const lineVal = tl.p1.price + tl.slopePerDay * (j - tl.p1.index);
    const diff = lineVal - candles[j].low;
    if (diff > maxBelow) maxBelow = diff;
  }
  return tl.currentLineValue - maxBelow;
}

/** 突破上升軌道線 = 強勢訊號（書本 p.387） */
export function hasUpChannelBreakout(
  candles: CandleWithIndicators[], index: number,
): boolean {
  const chLine = getUpChannelLine(candles, index);
  const c = candles[index];
  if (chLine == null || !c) return false;
  const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  return c.close > chLine && c.close > c.open && bodyPct >= 0.02;
}

/** 跌破下降軌道線 = 空頭轉強（書本 p.391） */
export function hasDownChannelBreakdown(
  candles: CandleWithIndicators[], index: number,
): boolean {
  const chLine = getDownChannelLine(candles, index);
  const c = candles[index];
  if (chLine == null || !c) return false;
  const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  return c.close < chLine && c.close < c.open && bodyPct >= 0.02;
}
