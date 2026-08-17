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
import { storedStrategyMatches, strategyStorageNamespace } from '@/lib/strategy/storageNamespace';

export function candidatePoolStorageKey(
  market: MarketId,
  date: string,
  strategyId?: string,
): string {
  const namespace = strategyStorageNamespace(strategyId);
  if (!namespace) {
    // 預設策略沿用舊路徑，避免既有正式資料搬遷後短暫斷鏈。
    return `agents/pool/${market}/${date}.json`;
  }
  return `agents/pool/${market}/strategies/${namespace}/${date}.json`;
}

function poolKey(market: MarketId, date: string, strategyId?: string): string {
  return candidatePoolStorageKey(market, date, strategyId);
}

function getPoolPath(market: MarketId, date: string, strategyId?: string): string {
  const namespace = strategyStorageNamespace(strategyId);
  if (namespace) {
    return path.join(
      process.cwd(), 'data', 'agents', 'pool', market, 'strategies', namespace, `${date}.json`,
    );
  }
  return path.join(process.cwd(), 'data', 'agents', 'pool', market, `${date}.json`);
}

export async function savePool(pool: CandidatesPool): Promise<string> {
  await agentsPut(poolKey(pool.market, pool.date, pool.strategyId), pool);
  return getPoolPath(pool.market, pool.date, pool.strategyId);
}

export async function loadPool(
  market: MarketId,
  date: string,
  expectedStrategyId?: string,
): Promise<CandidatesPool | null> {
  const pool = await agentsGet<CandidatesPool>(poolKey(market, date, expectedStrategyId));
  if (!pool) return null;
  if (expectedStrategyId && !poolBelongsToStrategy(pool, expectedStrategyId)) return null;
  return pool;
}

/** 舊版 pool 沒有 strategyId，只能安全歸到當時唯一的預設策略。 */
export function poolBelongsToStrategy(pool: CandidatesPool, strategyId: string): boolean {
  return storedStrategyMatches(pool.strategyId, strategyId);
}
