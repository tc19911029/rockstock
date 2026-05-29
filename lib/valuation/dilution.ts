import type { DilutionEvent, DilutionResult, ScenarioResult } from './types';

/**
 * 稀釋後 EPS = 原 EPS × 原股數 / 新股數
 */
export function computeDilutedEps(eps: number, originalShares: number, newShares: number): number {
  if (!newShares || newShares <= 0) return eps;
  return (eps * originalShares) / newShares;
}

/**
 * 稀釋比例 = 新增股數 / 原股數
 */
export function computeDilutionRatio(originalShares: number, addedShares: number): number {
  if (!originalShares || originalShares <= 0) return 0;
  return addedShares / originalShares;
}

/**
 * 把多筆 dilution events 加總出總新增股數。
 * 過濾掉預定日期已過或缺資料的項目。
 */
export function sumAddedShares(events: DilutionEvent[]): number {
  if (!events || events.length === 0) return 0;
  return events.reduce((s, e) => s + (e.newShares ?? 0), 0);
}

/**
 * 把三情境的 ScenarioResult 套用稀釋後 EPS 與合理價。
 */
export function buildDilutionResult(
  originalShares: number,
  addedShares: number,
  scenarios: { pessimistic: ScenarioResult; base: ScenarioResult; optimistic: ScenarioResult }
): DilutionResult | null {
  if (!originalShares || originalShares <= 0 || !addedShares || addedShares <= 0) return null;
  const newShares = originalShares + addedShares;
  const ratio = addedShares / originalShares;

  const dilute = (s: ScenarioResult) => {
    const dEps = computeDilutedEps(s.fullYearEps, originalShares, newShares);
    return {
      eps: dEps,
      price: dEps * s.fairPe,
    };
  };

  const p = dilute(scenarios.pessimistic);
  const b = dilute(scenarios.base);
  const o = dilute(scenarios.optimistic);

  return {
    originalShares,
    newShares,
    ratio,
    pessimisticDilutedEps: p.eps,
    baseDilutedEps: b.eps,
    optimisticDilutedEps: o.eps,
    pessimisticDilutedPrice: p.price,
    baseDilutedPrice: b.price,
    optimisticDilutedPrice: o.price,
  };
}
