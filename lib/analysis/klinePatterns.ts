/**
 * K 線組合 detector — 書本 Part 3 p.199-245
 *
 * 實作：
 *   - 變盤槌子/倒槌 4 種（p.224）
 *   - 上升三法 / 一星二陽 / 上漲連 3 紅（p.228-245）
 *   - 下降三法 / 一星二陰 / 下跌連 3 黑（鏡像）
 *   - 晨星 6 種變化（p.208）
 *   - 吞噬 / 強覆蓋 / 覆蓋 / 貫穿（p.199-206）
 */
import type { CandleWithIndicators } from '@/types';

function body(c: CandleWithIndicators): number { return Math.abs(c.close - c.open); }
function bodyPct(c: CandleWithIndicators): number { return c.open > 0 ? body(c) / c.open : 0; }
function isRed(c: CandleWithIndicators): boolean { return c.close > c.open; }
function isBlack(c: CandleWithIndicators): boolean { return c.close < c.open; }
function upperShadow(c: CandleWithIndicators): number { return c.high - Math.max(c.open, c.close); }
function lowerShadow(c: CandleWithIndicators): number { return Math.min(c.open, c.close) - c.low; }

// ────────────────────────────────────────────────────────────────
// 變盤槌子/倒槌（書本 p.224）
// 4 種：變盤紅K槌子、變盤黑K槌子、變盤紅K倒槌、變盤黑K倒槌
// 共通定義：小實體 + 影線 ≥ 實體 2 倍
// ────────────────────────────────────────────────────────────────

export function isHammer(c: CandleWithIndicators): boolean {
  const b = body(c);
  return b > 0 && lowerShadow(c) >= b * 2 && upperShadow(c) <= b * 0.5;
}

export function isInvertedHammer(c: CandleWithIndicators): boolean {
  const b = body(c);
  return b > 0 && upperShadow(c) >= b * 2 && lowerShadow(c) <= b * 0.5;
}

// ────────────────────────────────────────────────────────────────
// 繼續看漲（書本 p.228-235）
// ────────────────────────────────────────────────────────────────

/** 上升三法：紅K + 1-3 小K 不跌破紅K低 + 紅K 突破前高 */
export function detectRisingThreeMethods(
  candles: CandleWithIndicators[], index: number,
): boolean {
  if (index < 4) return false;
  const c = candles[index];
  if (!isRed(c) || bodyPct(c) < 0.02) return false;
  const leftRed = candles[index - 4];
  if (!isRed(leftRed) || bodyPct(leftRed) < 0.02) return false;
  const mid = candles.slice(index - 3, index);
  const noBreakLow = mid.every(k => k.close >= leftRed.low);
  return noBreakLow && c.close > leftRed.high;
}

/** 一星二陽：紅 + 小K/變盤 + 紅 */
export function detectOneStarTwoYang(
  candles: CandleWithIndicators[], index: number,
): boolean {
  if (index < 2) return false;
  const a = candles[index - 2];
  const b = candles[index - 1];
  const c = candles[index];
  return isRed(a) && bodyPct(a) >= 0.015
    && bodyPct(b) < 0.01
    && isRed(c) && bodyPct(c) >= 0.015
    && c.close > a.close;
}

/** 上漲連 3 紅：3 根紅K 連續上漲 */
export function detectThreeRisingRed(
  candles: CandleWithIndicators[], index: number,
): boolean {
  if (index < 2) return false;
  const a = candles[index - 2];
  const b = candles[index - 1];
  const c = candles[index];
  return isRed(a) && isRed(b) && isRed(c)
    && b.close > a.close && c.close > b.close;
}

// ────────────────────────────────────────────────────────────────
// 繼續看跌（書本 p.237-245）鏡像
// ────────────────────────────────────────────────────────────────

export function detectFallingThreeMethods(
  candles: CandleWithIndicators[], index: number,
): boolean {
  if (index < 4) return false;
  const c = candles[index];
  if (!isBlack(c) || bodyPct(c) < 0.02) return false;
  const leftBlack = candles[index - 4];
  if (!isBlack(leftBlack) || bodyPct(leftBlack) < 0.02) return false;
  const mid = candles.slice(index - 3, index);
  const noBreakHigh = mid.every(k => k.close <= leftBlack.high);
  return noBreakHigh && c.close < leftBlack.low;
}

export function detectOneStarTwoYin(
  candles: CandleWithIndicators[], index: number,
): boolean {
  if (index < 2) return false;
  const a = candles[index - 2];
  const b = candles[index - 1];
  const c = candles[index];
  return isBlack(a) && bodyPct(a) >= 0.015
    && bodyPct(b) < 0.01
    && isBlack(c) && bodyPct(c) >= 0.015
    && c.close < a.close;
}

export function detectThreeFallingBlack(
  candles: CandleWithIndicators[], index: number,
): boolean {
  if (index < 2) return false;
  const a = candles[index - 2];
  const b = candles[index - 1];
  const c = candles[index];
  return isBlack(a) && isBlack(b) && isBlack(c)
    && b.close < a.close && c.close < b.close;
}

// ────────────────────────────────────────────────────────────────
// 晨星 6 種（書本 p.208）
// 標準：黑K + 變盤線 + 紅K
// 6 種變化：標準 / 孤島 / 母子 / 雙星 / 雙肩 / 群星
// ────────────────────────────────────────────────────────────────

export interface MorningStarVariant {
  standard:  boolean;  // 標準（黑+變+紅）
  islandStar: boolean; // 孤島（變盤線下有缺口）
  insideStar: boolean; // 母子（變盤在黑K 實體內）
  twinStar:   boolean; // 雙星（2 個變盤線）
  tripleStar: boolean; // 雙肩/群星（多變盤線）
}

export function detectMorningStarVariants(
  candles: CandleWithIndicators[], index: number,
): MorningStarVariant {
  const empty: MorningStarVariant = {
    standard: false, islandStar: false, insideStar: false, twinStar: false, tripleStar: false,
  };
  if (index < 2) return empty;

  // 基本：最後是紅K
  const c = candles[index];
  if (!isRed(c) || bodyPct(c) < 0.02) return empty;

  // 找前 1-3 根內的「變盤線」和「黑K」
  const n1 = candles[index - 1];
  const n2 = index >= 2 ? candles[index - 2] : null;
  const n3 = index >= 3 ? candles[index - 3] : null;
  const n4 = index >= 4 ? candles[index - 4] : null;

  const isStar = (k: CandleWithIndicators | null): boolean => k != null && bodyPct(k) < 0.01;

  // 標準：黑 + 變 + 紅
  const standard = n2 != null && isBlack(n2) && bodyPct(n2) >= 0.02 && isStar(n1);

  // 孤島：變盤有缺口（前低 > 變盤高 OR 變盤低 > 後高）
  const islandStar = standard && n1.high < n2.low && c.low > n1.high;

  // 母子：變盤線在黑K 實體內
  const insideStar = standard && n1.high <= n2.open && n1.low >= n2.close;

  // 雙星：2 個變盤
  const twinStar = n3 != null && isBlack(n3) && isStar(n2) && isStar(n1);

  // 三星 / 雙肩（3+ 變盤）
  const tripleStar = n4 != null && isBlack(n4) && isStar(n3) && isStar(n2) && isStar(n1);

  return { standard, islandStar, insideStar, twinStar, tripleStar };
}

// ────────────────────────────────────────────────────────────────
// 吞噬 / 覆蓋 / 貫穿（書本 p.199-206）
// 吞噬已在 BacktestEngine 做，這裡提供獨立 detector 給 scan 用
// ────────────────────────────────────────────────────────────────

/** 高檔長黑吞噬（完全包覆前日紅K 實體） */
export function isBearishEngulfing(prev: CandleWithIndicators, c: CandleWithIndicators): boolean {
  return isRed(prev) && isBlack(c)
    && c.open >= prev.close
    && c.close <= prev.open
    && body(c) >= body(prev)
    && bodyPct(c) >= 0.02;
}

/** 低檔長紅吞噬 */
export function isBullishEngulfing(prev: CandleWithIndicators, c: CandleWithIndicators): boolean {
  return isBlack(prev) && isRed(c)
    && c.open <= prev.close
    && c.close >= prev.open
    && body(c) >= body(prev)
    && bodyPct(c) >= 0.02;
}

/** 強覆蓋（黑K 突破前日紅K 二分之一，p.199 烏雲罩頂） */
export function isStrongBearishCover(prev: CandleWithIndicators, c: CandleWithIndicators): boolean {
  if (!isRed(prev) || !isBlack(c)) return false;
  const midPoint = (prev.open + prev.close) / 2;
  return c.open > prev.high && c.close < midPoint && c.close > prev.open;
}

/** 強貫穿（低檔紅K 開高走高，書本 p.205） */
export function isBullishPiercing(prev: CandleWithIndicators, c: CandleWithIndicators): boolean {
  if (!isBlack(prev) || !isRed(c)) return false;
  return c.open > prev.open && c.close > prev.high;
}
