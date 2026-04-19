/**
 * 反轉結構 detector — 書本 Part 2 p.75-76, p.99-102
 *
 * 實作：
 *   - 做頭 2 個頭（多轉空三階段，p.75-76）
 *   - 一日反轉（高檔爆大量長黑K / 長上影線，p.74-75）
 *   - 多頭上漲後 4 種回檔（p.99-102）
 *   - 空頭下跌後 4 種反彈（鏡像）
 */
import type { CandleWithIndicators } from '@/types';
import { findPivots } from './trendAnalysis';

// ────────────────────────────────────────────────────────────────
// 做頭三階段（書本 p.75-76）
// 1. 第 1 個頭爆大量（第 1 次出貨量）
// 2. 第 2 個頭頭頭低 + 大量（主力出貨盤頭訊號）
// 3. 跌破前低 → 空頭反轉確認
// ────────────────────────────────────────────────────────────────

export type TopFormationStage = 'firstHead' | 'secondHead' | 'bearConfirmed' | null;

export function detectTopFormation(
  candles: CandleWithIndicators[],
  index: number,
): TopFormationStage {
  if (index < 20) return null;
  const pivots = findPivots(candles, index, 6);
  const highs = pivots.filter(p => p.type === 'high');
  const lows = pivots.filter(p => p.type === 'low');

  if (highs.length < 2 || lows.length < 1) {
    // 最近一個頭若爆大量 → 第 1 個頭
    if (highs.length >= 1) {
      const headIdx = highs[0].index;
      const hc = candles[headIdx];
      const avg5 = hc?.avgVol5 ?? 0;
      if (avg5 > 0 && hc.volume >= avg5 * 2) return 'firstHead';
    }
    return null;
  }

  const latestHigh = highs[0];
  const prevHigh = highs[1];
  const latestLow = lows[0];

  // 頭頭低 + 第 2 個頭大量
  if (latestHigh.price < prevHigh.price) {
    const hc = candles[latestHigh.index];
    const avg5 = hc?.avgVol5 ?? 0;
    const isBigVol = avg5 > 0 && hc.volume >= avg5 * 1.5;
    if (isBigVol) {
      // 跌破最新低點 → 空頭確認
      const c = candles[index];
      if (c.close < latestLow.price) return 'bearConfirmed';
      return 'secondHead';
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 一日反轉訊號（書本 p.74-75）
//   - 高檔爆大量長黑K（跌破大量低點）
//   - 高檔爆大量長上影線
// ────────────────────────────────────────────────────────────────

export function detectOneDayReversal(
  candles: CandleWithIndicators[],
  index: number,
): boolean {
  const c = candles[index];
  if (!c || index < 5) return false;
  const avg5 = c.avgVol5 ?? 0;
  if (avg5 <= 0 || c.volume < avg5 * 2) return false;

  // 高檔判定：MA20 乖離 >10%
  const highZone = c.ma20 && c.ma20 > 0 && (c.close - c.ma20) / c.ma20 > 0.10;
  if (!highZone) return false;

  const bodyAbs = Math.abs(c.close - c.open);
  const bodyPct = c.open > 0 ? bodyAbs / c.open : 0;
  const upperShadow = c.high - Math.max(c.open, c.close);

  // ① 爆量長黑 (實體≥2%)
  if (c.close < c.open && bodyPct >= 0.02) return true;
  // ② 爆量長上影線（上影 ≥ 實體 2 倍 OR 上影 >5%）
  if (upperShadow >= bodyAbs * 2 || (c.open > 0 && upperShadow / c.open > 0.05)) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────
// 多頭回檔 4 種情況（書本 p.99-102）
// 情況 1：弱勢回檔 <1/2，不破月線/前低 → 回後買上漲
// 情況 2：強勢回檔 >1/2，跌破月線/前低 → 頭頭低盤整
// 情況 3：盤整突破做多
// 情況 4：ABC 修正結束繼續做多
// ────────────────────────────────────────────────────────────────

export type PullbackType = 'weakPullback' | 'strongPullback' | 'rangeBreakout' | 'abcContinue' | null;

export function classifyPullback(
  candles: CandleWithIndicators[],
  index: number,
): PullbackType {
  if (index < 20) return null;
  const c = candles[index];
  const ma20 = c.ma20;
  if (!ma20) return null;

  // 找最近波段：取最近 10 日最高點
  let segHigh = -Infinity, segHighIdx = -1;
  for (let j = Math.max(0, index - 20); j <= index; j++) {
    if (candles[j].high > segHigh) { segHigh = candles[j].high; segHighIdx = j; }
  }
  if (segHigh <= 0 || segHighIdx < 0) return null;

  // 找該最高點後的最低點
  let segLow = Infinity;
  for (let j = segHighIdx; j <= index; j++) {
    if (candles[j].low < segLow) segLow = candles[j].low;
  }
  const retracement = segHigh > segLow ? (segHigh - c.close) / (segHigh - segLow) : 0;

  // 情況 1：弱勢回檔（<50%）+ 未破月線 + 今日紅K 反攻
  if (retracement < 0.5 && c.close > ma20 && c.close > c.open) return 'weakPullback';
  // 情況 2：強勢回檔（>50%）+ 破月線
  if (retracement >= 0.5 && c.close < ma20) return 'strongPullback';
  // 情況 3：盤整後突破（收盤突破近 10 日最高）
  const recent10High = Math.max(...candles.slice(Math.max(0, index - 10), index).map(k => k.high));
  if (c.close > recent10High && c.close > c.open) return 'rangeBreakout';
  // 情況 4：ABC 修正後站回月線
  if (c.close > ma20 && candles[index - 1].close < ma20) return 'abcContinue';
  return null;
}

// ────────────────────────────────────────────────────────────────
// 空頭反彈 4 種（鏡像）
// ────────────────────────────────────────────────────────────────

export type BearReboundType = 'weakRebound' | 'strongRebound' | 'rangeBreakdown' | 'abcContinueDown' | null;

export function classifyBearRebound(
  candles: CandleWithIndicators[],
  index: number,
): BearReboundType {
  if (index < 20) return null;
  const c = candles[index];
  const ma20 = c.ma20;
  if (!ma20) return null;

  let segLow = Infinity, segLowIdx = -1;
  for (let j = Math.max(0, index - 20); j <= index; j++) {
    if (candles[j].low < segLow) { segLow = candles[j].low; segLowIdx = j; }
  }
  if (segLow === Infinity || segLowIdx < 0) return null;

  let segHigh = -Infinity;
  for (let j = segLowIdx; j <= index; j++) {
    if (candles[j].high > segHigh) segHigh = candles[j].high;
  }
  const rebound = segHigh > segLow ? (c.close - segLow) / (segHigh - segLow) : 0;

  if (rebound < 0.5 && c.close < ma20 && c.close < c.open) return 'weakRebound';
  if (rebound >= 0.5 && c.close > ma20) return 'strongRebound';
  const recent10Low = Math.min(...candles.slice(Math.max(0, index - 10), index).map(k => k.low));
  if (c.close < recent10Low && c.close < c.open) return 'rangeBreakdown';
  if (c.close < ma20 && candles[index - 1].close > ma20) return 'abcContinueDown';
  return null;
}
