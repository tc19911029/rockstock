/**
 * 支撐壓力 detector — 書本 Part 6 p.472-481
 *
 * 實作：
 *   - 黃金分割率 0.236 / 0.382 / 0.5 / 0.618 / 0.809（p.472-474）
 *   - 型態目標價（M 頭 / W 底，p.475-479）
 *   - 整數心理關卡（p.480-481）
 *   - 大量紅K 3 支撐位（p.462 最高/1/2/最低）
 *   - 大量黑K 3 壓力位（鏡像）
 */
import type { CandleWithIndicators } from '@/types';

// ────────────────────────────────────────────────────────────────
// 黃金分割率（書本 p.472-474）
// ────────────────────────────────────────────────────────────────

export const GOLDEN_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.809];

export interface GoldenLevels {
  from:   number;
  to:     number;
  levels: Array<{ ratio: number; price: number }>;
}

/** 多頭回檔的黃金分割支撐（低→高） */
export function goldenRetracementSupport(low: number, high: number): GoldenLevels {
  const diff = high - low;
  return {
    from: low, to: high,
    levels: GOLDEN_RATIOS.map(r => ({ ratio: r, price: high - diff * r })),
  };
}

/** 空頭反彈的黃金分割壓力（高→低反向） */
export function goldenReboundResistance(high: number, low: number): GoldenLevels {
  const diff = high - low;
  return {
    from: high, to: low,
    levels: GOLDEN_RATIOS.map(r => ({ ratio: r, price: low + diff * r })),
  };
}

// ────────────────────────────────────────────────────────────────
// 整數心理關卡（書本 p.480-481）
// ────────────────────────────────────────────────────────────────

/** 找最近的整數關卡（<50 用 5 倍數、<200 用 10、<1000 用 100、>1000 用 1000） */
export function nearestIntegerLevel(price: number): number {
  let step = 1;
  if (price >= 1000) step = 1000;
  else if (price >= 200) step = 100;
  else if (price >= 50) step = 10;
  else step = 5;
  return Math.round(price / step) * step;
}

/** 是否靠近整數關卡（價差 <1%） */
export function isNearIntegerLevel(price: number): boolean {
  const level = nearestIntegerLevel(price);
  if (price <= 0) return false;
  return Math.abs(price - level) / price < 0.01;
}

// ────────────────────────────────────────────────────────────────
// 型態目標價（書本 p.475-479）
// M 頭 / W 底：目標距 = 頸線到頭/底的距離
// ────────────────────────────────────────────────────────────────

/** W 底目標價 = 頸線 + （頸線 - 底）距離 */
export function wBottomTarget(neckline: number, bottom: number): number {
  return neckline + (neckline - bottom);
}

/** M 頭目標價 = 頸線 - （頭 - 頸線）距離 */
export function mTopTarget(neckline: number, top: number): number {
  return neckline - (top - neckline);
}

// ────────────────────────────────────────────────────────────────
// 大量紅K 3 支撐位（書本 p.462）
// 最高點（最強）/ 二分之一（中） / 最低點（跌破=停損）
// ────────────────────────────────────────────────────────────────

export interface RedCandleSupport {
  strong:  number;  // 最高點（最強支撐）
  mid:     number;  // 二分之一（跌破 = 下跌力道轉強警示）
  weak:    number;  // 最低點（跌破 = 多空反轉停損）
}

/** 取當日紅K 3 支撐位 */
export function redCandleSupports(c: CandleWithIndicators): RedCandleSupport | null {
  if (c.close <= c.open) return null;  // 非紅K
  const mid = (c.close + c.open) / 2;
  return {
    strong: c.high,
    mid,
    weak:   c.low,
  };
}

/** 取當日黑K 3 壓力位（鏡像） */
export function blackCandleResistances(c: CandleWithIndicators): RedCandleSupport | null {
  if (c.close >= c.open) return null;
  const mid = (c.open + c.close) / 2;
  return {
    strong: c.low,   // 最強：最低點（突破後 = 上漲加速）
    mid,
    weak:   c.high,  // 最弱：最高點（突破 = 空多反轉）
  };
}

/** 判定當前價格位於紅K 3 支撐的哪一級（跌破哪些）*/
export function redSupportLevel(
  priceNow: number, support: RedCandleSupport,
): 'above' | 'belowStrong' | 'belowMid' | 'belowWeak' {
  if (priceNow >= support.strong) return 'above';
  if (priceNow >= support.mid) return 'belowStrong';
  if (priceNow >= support.weak) return 'belowMid';
  return 'belowWeak';  // 跌破 = 停損
}
