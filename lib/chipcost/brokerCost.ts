/**
 * 主力（分點）加權平均成本（#4）
 *
 *   cost = Σ(每日 top-15 分點淨買張數 × 當日VWAP) / Σ淨買張數
 *
 * ⚠️ 這是「前 15 大券商分點淨買」聚合 proxy，非籌碼K線逐分點庫存成本。
 * ⚠️ Yahoo 分點來源只有「當日」快照，歷史靠 cron 每日累積（data/chips/TW/broker），
 *    歷史不足 MIN_DAYS 日時視為「accumulating」，UI 不應顯示為精準值。
 */

import type { PriceDay } from '@/lib/squeeze/types';
import { weightedCost } from '@/lib/squeeze/costEstimator';
import type { BrokerDay } from '@/lib/chips/types';
import type { CostBucket, BrokerCostStatus } from './types';
import { EMPTY_BUCKET } from './types';

const WINDOWS = [5, 10, 20, 60] as const;
/** 歷史 < 此天數 → 主力成本標示「累積中」（估算不可信） */
export const BROKER_MIN_DAYS = 20;

type BrokerRow = { date: string } & BrokerDay;

export function computeBrokerCosts(broker: BrokerRow[], prices: PriceDay[]): CostBucket {
  const priceMap = new Map<string, number>();
  for (const p of prices) priceMap.set(p.date, p.vwap);

  const out: CostBucket = { ...EMPTY_BUCKET };
  for (const n of WINDOWS) {
    const win = broker.slice(-n).map(r => ({ date: r.date, lots: r.netDifference }));
    out[`d${n}` as keyof CostBucket] = weightedCost(win, priceMap);
  }
  return out;
}

export function brokerCostStatus(brokerDays: number): BrokerCostStatus {
  if (brokerDays === 0) return 'unavailable';
  if (brokerDays < BROKER_MIN_DAYS) return 'accumulating';
  return 'ok';
}
