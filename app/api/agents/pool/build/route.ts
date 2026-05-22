/**
 * POST /api/agents/pool/build?date=&market=
 *
 * 跑 4 個 Source extractor、合併去重、寫 data/agents/pool/{market}/{date}.json
 *
 * 不打 LLM — 純資料整理（cron 可直接跑）
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { technicalSource } from '@/lib/agents/candidates/sources/technicalSource';
import { youtubeSource }   from '@/lib/agents/candidates/sources/youtubeSource';
import { chipSource }      from '@/lib/agents/candidates/sources/chipSource';
import { fundamentalSource } from '@/lib/agents/candidates/sources/fundamentalSource';
import { mergeCandidates } from '@/lib/agents/candidates/merger';
import { savePool } from '@/lib/agents/candidates/poolStorage';
import type { MarketId } from '@/lib/scanner/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function POST(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { market, date } = parsed.data;

  const startedAt = Date.now();

  // 並行跑 4 個 source（任一失敗不影響其他）
  const results = await Promise.all([
    technicalSource.extract({ market: market as MarketId, date }),
    youtubeSource.extract({ market: market as MarketId, date }),
    chipSource.extract({ market: market as MarketId, date }),
    fundamentalSource.extract({ market: market as MarketId, date }),
  ]);

  const pool = mergeCandidates({ market: market as MarketId, date, results });

  const file = await savePool(pool);

  const elapsedMs = Date.now() - startedAt;

  // 統計
  const distribution = {
    sourceCount4: pool.candidates.filter(c => c.sourceCount === 4).length,
    sourceCount3: pool.candidates.filter(c => c.sourceCount === 3).length,
    sourceCount2: pool.candidates.filter(c => c.sourceCount === 2).length,
    sourceCount1: pool.candidates.filter(c => c.sourceCount === 1).length,
  };

  return apiOk({
    date,
    market,
    file,
    elapsedMs,
    total: pool.candidates.length,
    distribution,
    sourceStatus: pool.sourceStatus,
  });
}
