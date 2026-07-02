/**
 * 三大法人加權平均進場成本（#1 外資 / #2 投信 / #3 自營商）
 *
 *   cost = Σ(該法人單日淨買張數 × 當日VWAP) / Σ淨買張數
 *
 * 只取淨買 > 0 的日子（weightedCost 內部過濾）。
 * 資料：lib/chips/ChipStorage readInstStock（foreign/trust/dealer 日歷史）。
 */

import type { PriceDay } from '@/lib/squeeze/types';
import { weightedCost } from '@/lib/squeeze/costEstimator';
import type { InstDay } from '@/lib/chips/types';
import type { CostBucket } from './types';
import { EMPTY_BUCKET } from './types';

const WINDOWS = [5, 10, 20, 60] as const;

type InstRow = { date: string } & InstDay;

export interface InstCosts {
  foreign: CostBucket;
  trust: CostBucket;
  dealer: CostBucket;
}

export function computeInstCosts(inst: InstRow[], prices: PriceDay[]): InstCosts {
  const priceMap = new Map<string, number>();
  for (const p of prices) priceMap.set(p.date, p.vwap);

  const out: InstCosts = {
    foreign: { ...EMPTY_BUCKET },
    trust: { ...EMPTY_BUCKET },
    dealer: { ...EMPTY_BUCKET },
  };

  for (const n of WINDOWS) {
    const win = inst.slice(-n);
    const key = `d${n}` as keyof CostBucket;
    out.foreign[key] = weightedCost(win.map(r => ({ date: r.date, lots: r.foreign })), priceMap);
    out.trust[key]   = weightedCost(win.map(r => ({ date: r.date, lots: r.trust })), priceMap);
    out.dealer[key]  = weightedCost(win.map(r => ({ date: r.date, lots: r.dealer })), priceMap);
  }
  return out;
}
