/**
 * Pool storage — 寫/讀 data/agents/pool/{market}/{date}.json
 *
 * 採同 scanStorage 風格：本地 FS + Vercel Blob dual-storage（dev 只用 FS）
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import type { CandidatesPool } from './types';
import type { MarketId } from '@/lib/scanner/types';

function getPoolPath(market: MarketId, date: string): string {
  return path.join(process.cwd(), 'data', 'agents', 'pool', market, `${date}.json`);
}

export async function savePool(pool: CandidatesPool): Promise<string> {
  const file = getPoolPath(pool.market, pool.date);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicFsPut(file, JSON.stringify(pool, null, 2));
  return file;
}

export async function loadPool(
  market: MarketId, date: string,
): Promise<CandidatesPool | null> {
  const file = getPoolPath(market, date);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as CandidatesPool;
  } catch {
    return null;
  }
}
