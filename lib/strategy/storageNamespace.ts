export const DEFAULT_SCAN_STRATEGY_ID = 'zhu-pure-book';

function strategyIdHash(strategyId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < strategyId.length; i++) {
    hash ^= strategyId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

/** 預設策略保留 legacy 路徑；其他策略取得穩定、防碰撞的安全命名空間。 */
export function strategyStorageNamespace(strategyId?: string): string | null {
  if (!strategyId || strategyId === DEFAULT_SCAN_STRATEGY_ID) return null;
  const safe = strategyId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (safe === strategyId && safe.length <= 80) return safe;
  return `${safe.slice(0, 68) || 'strategy'}-${strategyIdHash(strategyId)}`;
}

export function storedStrategyMatches(storedStrategyId: string | undefined, expectedStrategyId: string): boolean {
  return (storedStrategyId ?? DEFAULT_SCAN_STRATEGY_ID) === expectedStrategyId;
}
