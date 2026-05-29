// ============================================================
// 三色資金 — forward 報酬量測（以「隔日開盤」為進場價，貼近實單）
//
// 為什麼用隔日開盤：盤後掃到 → 隔天才買，書本也是上漲日 13:20 看、13:25 掛市價，
// 不會用訊號日收盤成交。ForwardAnalyzer 已備好 nextOpenPrice + forwardCandles +
// 漲停鎖死偵測（買不到 → nextOpenPrice=null）。鎖死/無資料 → 全 null，該樣本被剔除。
// ============================================================

import type { StockForwardPerformance } from '@/lib/scanner/types';
import { BT_HORIZONS, type HKey } from './rankingScore';

const empty = (): Record<HKey, number | null> =>
  Object.fromEntries(BT_HORIZONS.map((h) => [h.key, null])) as Record<HKey, number | null>;

/** 由隔日開盤進場，算各 horizon 收盤報酬 + 窗內最高/最低。買不到 → 全 null。 */
export function metricsFromOpen(perf: StockForwardPerformance | undefined | null): Record<HKey, number | null> {
  const out = empty();
  if (!perf) return out;
  const base = perf.nextOpenPrice;
  const fc = perf.forwardCandles;
  if (base == null || base <= 0 || !fc || fc.length === 0) return out;

  // 隔日開相對掃描收盤的跳空（資訊欄：追停時你已經多付的價差）
  out.openReturn = perf.openReturn ?? null;
  const closeRet = (idx: number): number | null =>
    idx < fc.length ? +(((fc[idx].close - base) / base) * 100).toFixed(2) : null;
  out.d1Return = closeRet(0);
  out.d3Return = closeRet(2);
  out.d5Return = closeRet(4);
  out.d10Return = closeRet(9);
  out.d20Return = closeRet(19);

  let mg = 0;
  let ml = 0;
  for (const c of fc) {
    const hi = ((c.high - base) / base) * 100;
    const lo = ((c.low - base) / base) * 100;
    if (hi > mg) mg = hi;
    if (lo < ml) ml = lo;
  }
  out.maxGain = +mg.toFixed(2);
  out.maxLoss = +ml.toFixed(2);
  return out;
}
