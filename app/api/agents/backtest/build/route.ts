/**
 * POST /api/agents/backtest/build?date=&market=
 *
 * 對該日所有 FinalDecision 接 ForwardAnalyzer 算 d1-d20，
 * 寫 data/agents/backtest/{market}/{date}.json
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { buildBacktest } from '@/lib/agents/backtest/builder';
import { saveBacktest } from '@/lib/agents/backtest/storage';
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

  const started = Date.now();
  const report = await buildBacktest({ market: market as MarketId, date });
  const file = await saveBacktest(report);
  const elapsedMs = Date.now() - started;

  const byAction = {
    buy:   report.entries.filter(e => e.action === 'buy').length,
    watch: report.entries.filter(e => e.action === 'watch').length,
    skip:  report.entries.filter(e => e.action === 'skip').length,
  };

  return apiOk({
    date,
    market,
    file,
    elapsedMs,
    total: report.entries.length,
    computedThrough: report.computedThrough,
    byAction,
  });
}
