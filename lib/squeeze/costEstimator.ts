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

export interface Lot { date: string; lots: number }

/**
 * 加權平均成本（共用 primitive）：
 *
 *   cost = Σ(每日新增張數 × 當日VWAP) / Σ每日新增張數
 *
 * 只計正值日（「新建立」批次）；淨減少日不納入分母。無有效批次回 null。
 * 融資 / 融券 / 借券 / 法人 / 主力 全部共用這一份數學（單一事實來源）。
 */
export function weightedCost(lots: Lot[], priceByDate: Map<string, number>): number | null {
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

/** @deprecated 改用 weightedCost；保留別名供既有 squeeze 測試與呼叫端維持綠燈 */
export const weightedShortCost = weightedCost;

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
    out.margin[key]   = weightedCost(mWin, priceMap);
    out.sbl[key]      = weightedCost(sWin, priceMap);
    // 綜合 = 兩個 lot 流合併
    out.combined[key] = weightedCost([...mWin, ...sWin], priceMap);
  }

  return out;
}
