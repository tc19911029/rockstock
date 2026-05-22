/**
 * GET /api/agents/backtest?market=&from=&to=&date=
 *
 * 兩種模式：
 *   - 單日：?date=2026-05-22 → 回該日 BacktestReport
 *   - 區間：?from=...&to=... → 回 summary（各 action / 各 agent verdict 統計）
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { listBacktestDates, loadBacktest } from '@/lib/agents/backtest/storage';
import { aggregateBacktestSummary } from '@/lib/agents/backtest/summary';
import type { MarketId } from '@/lib/scanner/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { market, date, from, to } = parsed.data;

  if (date) {
    // 單日模式
    const report = await loadBacktest(market as MarketId, date);
    return apiOk({
      mode: 'single',
      date, market,
      exists: !!report,
      report,
    });
  }

  // 區間模式（預設 from=最舊、to=今日）
  const dates = await listBacktestDates(market as MarketId);
  const filtered = dates.filter(d => {
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });

  if (filtered.length === 0) {
    return apiOk({
      mode: 'range',
      market, from, to,
      datesIncluded: [],
      summary: null,
    });
  }

  const reports = await Promise.all(
    filtered.map(d => loadBacktest(market as MarketId, d)),
  );
  const validReports = reports.filter((r): r is NonNullable<typeof r> => r !== null);

  const summary = aggregateBacktestSummary(
    validReports,
    from ?? filtered[filtered.length - 1],
    to ?? filtered[0],
  );

  return apiOk({
    mode: 'range',
    market, from, to,
    datesIncluded: filtered,
    summary,
  });
}
