/**
 * 融資（多方）加權平均成本（#5）
 *
 *   cost = Σ(每日融資淨增張數 × 當日VWAP) / Σ淨增張數
 *
 * 只取 marginNet > 0 的日子（新建立融資批次）；weightedCost 內部已過濾。
 */

import type { MarginDay, PriceDay } from '@/lib/squeeze/types';
import { weightedCost } from '@/lib/squeeze/costEstimator';
import type { CostBucket } from './types';
import { EMPTY_BUCKET } from './types';

const WINDOWS = [5, 10, 20, 60] as const;

export function computeMarginLongCosts(margin: MarginDay[], prices: PriceDay[]): CostBucket {
  const priceMap = new Map<string, number>();
  for (const p of prices) priceMap.set(p.date, p.vwap);

  const out: CostBucket = { ...EMPTY_BUCKET };
  for (const n of WINDOWS) {
    const win = margin.slice(-n).map(r => ({ date: r.date, lots: r.marginNet }));
    out[`d${n}` as keyof CostBucket] = weightedCost(win, priceMap);
  }
  return out;
}
