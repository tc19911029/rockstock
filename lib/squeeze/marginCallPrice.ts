/**
 * 推估融券追繳壓力價
 *
 *   融券追繳壓力價 = 空方成本 × (1 + 融券保證金成數) / 1.3
 *
 * 預設融券保證金成數 = 90% （台股一般客戶）
 *
 * 注意：這不是「強制回補價」，只是「整戶維持率開始接近 130% 警戒」的估算。
 */

export const DEFAULT_MARGIN_RATIO = 0.9;
export const MAINTENANCE_RATIO = 1.3;

export function marginCallPrice(shortCost: number | null, marginRatio = DEFAULT_MARGIN_RATIO): number | null {
  if (shortCost === null || !Number.isFinite(shortCost) || shortCost <= 0) return null;
  return +((shortCost * (1 + marginRatio)) / MAINTENANCE_RATIO).toFixed(2);
}
