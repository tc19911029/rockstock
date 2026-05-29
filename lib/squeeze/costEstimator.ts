/**
 * 加權平均空方成本
 *
 *   cost = Σ(每日新增空單張數 × 當日 VWAP) / Σ 每日新增空單張數
 *
 * 規則（依用戶 spec）：
 *   - 「新增空單張數」= shortNet（融券）或 lendingNet（借券）
 *   - 負值（淨回補）天不納入分母（只看「新建立」批次）；若全期間皆為負或 0，回 null
 *   - 綜合 = 融券新增 + 借券新增 一起加權
 *
 * 同時暴露 weightedShortCost() 供測試直接呼叫。
 */

import type { MarginDay, SblDay, PriceDay, ShortCostBuckets } from './types';

interface Lot { date: string; lots: number }

export function weightedShortCost(lots: Lot[], priceByDate: Map<string, number>): number | null {
  let num = 0;
  let den = 0;
  for (const l of lots) {
    if (l.lots <= 0) continue;
    const p = priceByDate.get(l.date);
    if (!p || !Number.isFinite(p)) continue;
    num += l.lots * p;
    den += l.lots;
  }
  if (den === 0) return null;
  return +(num / den).toFixed(2);
}

function takeLastNTradingDays<T extends { date: string }>(rows: T[], n: number): T[] {
  return rows.slice(-n);
}

export function computeShortCosts(
  margin: MarginDay[],
  sbl: SblDay[],
  prices: PriceDay[],
): ShortCostBuckets {
  const priceMap = new Map<string, number>();
  for (const p of prices) priceMap.set(p.date, p.vwap);

  const windows = [5, 10, 20, 60] as const;
  const out: ShortCostBuckets = {
    margin:   { d5: null, d10: null, d20: null, d60: null },
    sbl:      { d5: null, d10: null, d20: null, d60: null },
    combined: { d5: null, d10: null, d20: null, d60: null },
  };

  for (const n of windows) {
    const mWin = takeLastNTradingDays(margin, n).map(r => ({ date: r.date, lots: r.shortNet }));
    const sWin = takeLastNTradingDays(sbl, n).map(r => ({ date: r.date, lots: r.lendingNet }));
    const key = `d${n}` as 'd5' | 'd10' | 'd20' | 'd60';
    out.margin[key]   = weightedShortCost(mWin, priceMap);
    out.sbl[key]      = weightedShortCost(sWin, priceMap);
    // 綜合 = 兩個 lot 流合併
    out.combined[key] = weightedShortCost([...mWin, ...sWin], priceMap);
  }

  return out;
}
