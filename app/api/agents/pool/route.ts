/**
 * GET /api/agents/pool?date=&market=&minSourceCount=&limit=&sort=
 *
 * 讀 data/agents/pool/{market}/{date}.json
 *
 * 參數：
 *   minSourceCount: 過濾掉 sourceCount < 此值的（預設讀 POOL_MIN_SOURCE_COUNT_DEFAULT）
 *   limit: 截 top N（預設 50）
 *   sort: 'sourceCount' (現有預設) 或 'weighted'（B3：≥N 共識後按 totalScore desc）
 *
 * B3 兩層過濾：
 *   1. 先 filter sourceCount >= minSourceCount
 *   2. 用 computeFacetScores(c) 算 totalScore，附在 response 上
 *   3. sort=weighted 時改用 totalScore 排序
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { loadPool } from '@/lib/agents/candidates/poolStorage';
import {
  computeFacetScores,
  POOL_MIN_SOURCE_COUNT_DEFAULT,
  POOL_WEIGHTS,
} from '@/lib/agents/candidates/poolWeights';
import type { MarketId } from '@/lib/scanner/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  minSourceCount: z.coerce.number().int().min(1).max(4).default(POOL_MIN_SOURCE_COUNT_DEFAULT),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.enum(['sourceCount', 'weighted']).default('weighted'),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { market, date, minSourceCount, limit, sort } = parsed.data;

  const pool = await loadPool(market as MarketId, date);
  if (!pool) {
    return apiOk({ date, market, exists: false, candidates: [], total: 0, weights: POOL_WEIGHTS });
  }

  // 第一層：≥N 面向共識
  const passed = pool.candidates.filter(c => c.sourceCount >= minSourceCount);

  // 算每檔 facet scores
  const withScores = passed.map(c => ({ ...c, scores: computeFacetScores(c) }));

  // 第二層排序
  if (sort === 'weighted') {
    withScores.sort((a, b) => b.scores.total - a.scores.total);
  }
  // sort === 'sourceCount' 時保留 pool 已排好的順序（sourceCount + strengthSignals）

  const sliced = withScores.slice(0, limit);

  return apiOk({
    date,
    market,
    exists: true,
    generatedAt: pool.generatedAt,
    sourceStatus: pool.sourceStatus,
    total: pool.candidates.length,
    returned: sliced.length,
    minSourceCount,
    sort,
    weights: POOL_WEIGHTS,
    distribution: {
      sourceCount4: pool.candidates.filter(c => c.sourceCount === 4).length,
      sourceCount3: pool.candidates.filter(c => c.sourceCount === 3).length,
      sourceCount2: pool.candidates.filter(c => c.sourceCount === 2).length,
      sourceCount1: pool.candidates.filter(c => c.sourceCount === 1).length,
    },
    candidates: sliced,
  });
}
