/**
 * Pool storage — 寫/讀 agents/pool/{market}/{date}.json
 *
 * 採同 scanStorage / youtube analysisStorage pattern：
 *   Vercel：寫 Vercel Blob
 *   Local：寫 data/agents/pool/{market}/{date}.json
 *
 * 2026-05-25：原本只寫本地 FS，導致 Vercel cron 跑了也 cold start 消失。
 *             改透過 lib/agents/persistStorage 統一 dual-storage。
 */

import path from 'node:path';
import { agentsPut, agentsGet } from '@/lib/agents/persistStorage';
import type { CandidatesPool } from './types';
import type { MarketId } from '@/lib/scanner/types';

const LEGACY_POOL_STRATEGY_ID = 'zhu-pure-book';

function poolKey(market: MarketId, date: string): string {
  return `agents/pool/${market}/${date}.json`;
}

/** legacy 給已存在的 caller（顯示路徑用），回 FS 上的絕對位置 */
function getPoolPath(market: MarketId, date: string): string {
  return path.join(process.cwd(), 'data', 'agents', 'pool', market, `${date}.json`);
}

export async function savePool(pool: CandidatesPool): Promise<string> {
  await agentsPut(poolKey(pool.market, pool.date), pool);
  return getPoolPath(pool.market, pool.date);
}

export async function loadPool(
  market: MarketId,
  date: string,
  expectedStrategyId?: string,
): Promise<CandidatesPool | null> {
  const pool = await agentsGet<CandidatesPool>(poolKey(market, date));
  if (!pool) return null;
  if (expectedStrategyId && !poolBelongsToStrategy(pool, expectedStrategyId)) return null;
  return pool;
}

/** 舊版 pool 沒有 strategyId，只能安全歸到當時唯一的預設策略。 */
export function poolBelongsToStrategy(pool: CandidatesPool, strategyId: string): boolean {
  return (pool.strategyId ?? LEGACY_POOL_STRATEGY_ID) === strategyId;
}
