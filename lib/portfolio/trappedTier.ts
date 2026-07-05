/**
 * 套牢分級 + 反彈遇壓不漲偵測（課程 CH10-1 散戶常見問題解答，2026-07-04）
 *
 * 課程規則：
 *   - 套牢 = 賠損超過 10% 而持有（TRAPPED_PCT）
 *   - 套牢 10~20%：「股票反彈遇壓不漲時認賠出場」
 *   - 套牢 >20% 空頭不變：三條路 — ①反彈賣出後反手做空 ②換其它多頭股 ③已大量止跌打底 → 等反轉多頭時加碼
 *
 * 純函式、無 IO — holdingsActionEngine 與測試共用。
 * 這些訊號是「已套牢存量部位」的課程建議附註：engine 的硬停損（>10% 必走）action 不變，
 * 套牢訊號以附加 signal 形式並列（能走到這裡通常代表使用者沒執行硬停損）。
 */
import type { Candle } from '@/types';
import { TRAPPED_PCT, TRAPPED_DEEP_PCT } from '@/lib/analysis/bookThresholds';

export type TrappedTier = 'none' | 'trapped_10_20' | 'trapped_over_20';

// ⚠️ 自創 padding（課程只說「反彈遇壓不漲」，未量化）— 工程化參數，export 給測試
/** 反彈成立：自波段低點反彈最少幅度 */
export const REBOUND_MIN_PCT = 0.03;
/** 遇壓：盤中高點觸及壓力 ×0.98 以上、收盤仍在壓力之下 */
export const RESISTANCE_TOUCH_RATIO = 0.98;
/** 不漲確認：觸壓日之後連 N 日未創反彈新高 */
export const STALL_CONFIRM_DAYS = 3;
/** 波段低點回看窗（根） */
export const SWING_LOW_LOOKBACK = 30;

export function classifyTrappedTier(profitPct: number): TrappedTier {
  if (profitPct <= -TRAPPED_DEEP_PCT) return 'trapped_over_20';
  if (profitPct <= -TRAPPED_PCT) return 'trapped_10_20';
  return 'none';
}

export interface ReboundStallResult {
  stalled: boolean;
  detail: string;
}

function sma(closes: number[], end: number, n: number): number | null {
  if (end < n - 1 || n <= 0) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += closes[i];
  return s / n;
}

/**
 * 「反彈遇壓不漲」可程式化定義（課程 CH10-1 反手做空圖解的壓力線畫的是 MA20）：
 *   1. 反彈成立：近 SWING_LOW_LOOKBACK 根的最低點之後，最高 high ≥ 低點 ×(1+REBOUND_MIN_PCT)
 *   2. 遇壓：反彈段中任一日 high ≥ 當日 MA20 × RESISTANCE_TOUCH_RATIO 且 close < 當日 MA20
 *   3. 不漲確認：觸壓日之後 ≥ STALL_CONFIRM_DAYS 根，且皆未創反彈新高
 * 三條全中 → stalled=true（課程：認賠出場）。
 */
export function detectReboundStallAtResistance(candles: Candle[]): ReboundStallResult {
  const last = candles.length - 1;
  if (last < 25) return { stalled: false, detail: 'K 線不足' };
  const closes = candles.map(c => c.close);

  // 1. 波段低點（近 SWING_LOW_LOOKBACK 根最低 low）
  const start = Math.max(0, last - SWING_LOW_LOOKBACK + 1);
  let lowIdx = start;
  for (let i = start; i <= last; i++) {
    if (candles[i].low < candles[lowIdx].low) lowIdx = i;
  }
  const swingLow = candles[lowIdx].low;
  if (lowIdx >= last) return { stalled: false, detail: '今日即波段低點，尚無反彈' };

  // 反彈成立？
  let reboundHigh = -Infinity;
  for (let i = lowIdx + 1; i <= last; i++) {
    if (candles[i].high > reboundHigh) reboundHigh = candles[i].high;
  }
  const reboundPct = reboundHigh / swingLow - 1;
  if (reboundPct < REBOUND_MIN_PCT) {
    return { stalled: false, detail: `反彈僅 ${(reboundPct * 100).toFixed(1)}% 未成立` };
  }

  // 2. 遇壓：反彈段內首個「觸 MA20 被壓回」日
  let touchIdx = -1;
  let touchMa20 = 0;
  for (let i = lowIdx + 1; i <= last; i++) {
    const ma20 = sma(closes, i, 20);
    if (ma20 == null) continue;
    if (candles[i].high >= ma20 * RESISTANCE_TOUCH_RATIO && candles[i].close < ma20) {
      touchIdx = i;
      touchMa20 = ma20;
      break;
    }
  }
  if (touchIdx < 0) return { stalled: false, detail: '反彈中，尚未觸壓' };

  // 3. 不漲確認：觸壓日後連 N 日未創反彈新高
  const daysAfter = last - touchIdx;
  if (daysAfter < STALL_CONFIRM_DAYS) {
    return { stalled: false, detail: `觸壓後僅 ${daysAfter} 日，觀察中` };
  }
  let highAtTouch = -Infinity;
  for (let i = lowIdx + 1; i <= touchIdx; i++) {
    if (candles[i].high > highAtTouch) highAtTouch = candles[i].high;
  }
  for (let i = touchIdx + 1; i <= last; i++) {
    if (candles[i].high > highAtTouch) {
      return { stalled: false, detail: '觸壓後仍創反彈新高，反彈未死' };
    }
  }
  return {
    stalled: true,
    detail: `自低點 ${swingLow.toFixed(2)} 反彈 ${(reboundPct * 100).toFixed(1)}% 觸 MA20 ${touchMa20.toFixed(2)} 被壓回，後 ${daysAfter} 日未創反彈新高`,
  };
}

export interface TrappedSignal {
  type: string;
  label: string;
  severity: 'high' | 'medium' | 'low';
  detail: string;
}

/**
 * 給 holdingsActionEngine 的套牢附加訊號（append 在停損分支的 signals 後面，不改 action）。
 * profitPct > -10% 回空陣列。
 */
export function buildTrappedSignals(profitPct: number, candles: Candle[]): TrappedSignal[] {
  const tier = classifyTrappedTier(profitPct);
  if (tier === 'none') return [];
  if (tier === 'trapped_10_20') {
    const stall = detectReboundStallAtResistance(candles);
    if (stall.stalled) {
      return [{
        type: 'trapped_rebound_stall',
        label: '套牢10-20%：反彈遇壓不漲（認賠出場）',
        severity: 'high',
        detail: `${stall.detail}。課程 CH10-1：套牢 10~20% 反彈遇壓不漲時認賠出場`,
      }];
    }
    return [{
      type: 'trapped_flag',
      label: '套牢（賠損 10-20%）',
      severity: 'medium',
      detail: `賠損 ${(profitPct * 100).toFixed(1)}% 已套牢（${stall.detail}）。課程 CH10-1：反彈遇壓不漲時認賠出場`,
    }];
  }
  return [{
    type: 'trapped_deep_three_paths',
    label: '深度套牢（>20%）三條路',
    severity: 'medium',
    detail: `賠損 ${(profitPct * 100).toFixed(1)}%。課程 CH10-1 三條路：①空頭不變 → 反彈賣出後反手做空（限空頭初段，跌深不空；底底高就回補）②反彈賣出換其它多頭股 ③已大量止跌打底 → 不要賣在最低檔，等反轉多頭時加碼`,
  }];
}
