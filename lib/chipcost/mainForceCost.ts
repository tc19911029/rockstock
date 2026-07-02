/**
 * 主力成本「綜合估算」fallback（#4 的歷史替代）
 *
 * 背景：真正的「分點主力」歷史在台股是付費資料（Goodinfo 擋、FinMind 分點需付費層），
 *      Yahoo 分點只有當日。為了能「現在就回推」出主力成本，用我們已有完整歷史的
 *      法人 + 融資 + 借券 合成「主力綜合」，對齊 /api/chip 的 computeComposite 口徑：
 *
 *   主力綜合(張) = 外資 + 投信 + 自營 − 0.7×借券淨賣 − 0.5×融資淨增
 *   主力成本 = Σ(主力綜合>0 當日 × 當日VWAP) / Σ(主力綜合>0)
 *
 * ⚠️ 這是「綜合估算」proxy，非籌碼K線的逐分點庫存成本；UI 會標示 method=composite。
 *    待 Yahoo 分點透過 cron 累積 ≥20 日後，自動改用較純的分點口徑（method=branch）。
 */

import type { MarginDay, SblDay, PriceDay } from '@/lib/squeeze/types';
import type { InstDay } from '@/lib/chips/types';
import { weightedCost } from '@/lib/squeeze/costEstimator';
import type { CostBucket } from './types';
import { EMPTY_BUCKET } from './types';

const WINDOWS = [5, 10, 20, 60] as const;
type InstRow = { date: string } & InstDay;

export function computeMainForceCompositeCosts(
  inst: InstRow[],
  margin: MarginDay[],
  sbl: SblDay[],
  prices: PriceDay[],
): CostBucket {
  const priceMap = new Map<string, number>();
  for (const p of prices) priceMap.set(p.date, p.vwap);
  const mNet = new Map<string, number>();
  for (const m of margin) mNet.set(m.date, m.marginNet);
  const lNet = new Map<string, number>();
  for (const s of sbl) lNet.set(s.date, s.lendingNet);

  // 以法人日序為主軸（主力綜合的核心是三大法人）；缺融資/借券當 0
  const lots = inst.map(r => ({
    date: r.date,
    lots: r.foreign + r.trust + r.dealer - (lNet.get(r.date) ?? 0) * 0.7 - (mNet.get(r.date) ?? 0) * 0.5,
  }));

  const out: CostBucket = { ...EMPTY_BUCKET };
  for (const n of WINDOWS) {
    out[`d${n}` as keyof CostBucket] = weightedCost(lots.slice(-n), priceMap);
  }
  return out;
}
