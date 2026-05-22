/**
 * GET /api/agents/pool?date=&market=&minSourceCount=&limit=
 *
 * 讀 data/agents/pool/{market}/{date}.json
 *
 * 參數：
 *   minSourceCount: 過濾掉 sourceCount < 此值的（預設 1）
 *   limit: 截 top N（預設 50）
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { loadPool } from '@/lib/agents/candidates/poolStorage';
import type { MarketId } from '@/lib/scanner/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  minSourceCount: z.coerce.number().int().min(1).max(4).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { market, date, minSourceCount, limit } = parsed.data;

  const pool = await loadPool(market as MarketId, date);
  if (!pool) {
    return apiOk({ date, market, exists: false, candidates: [], total: 0 });
  }

  const filtered = pool.candidates.filter(c => c.sourceCount >= minSourceCount).slice(0, limit);

  return apiOk({
    date,
    market,
    exists: true,
    generatedAt: pool.generatedAt,
    sourceStatus: pool.sourceStatus,
    total: pool.candidates.length,
    returned: filtered.length,
    minSourceCount,
    distribution: {
      sourceCount4: pool.candidates.filter(c => c.sourceCount === 4).length,
      sourceCount3: pool.candidates.filter(c => c.sourceCount === 3).length,
      sourceCount2: pool.candidates.filter(c => c.sourceCount === 2).length,
      sourceCount1: pool.candidates.filter(c => c.sourceCount === 1).length,
    },
    candidates: filtered,
  });
}
