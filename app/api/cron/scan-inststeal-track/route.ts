import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { assertL1Coverage } from '@/lib/scanner/coverageGuard';
import { runInstStealTrack } from '@/lib/scanner/instStealTrack';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const date = req.nextUrl.searchParams.get('date') ?? getLastTradingDay('TW');
  if (!isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: 'non-trading day', market: 'TW', date });
  }
  const coverage = await assertL1Coverage('TW', date);
  if (!coverage.ok) {
    return apiError(`TW ${date} L1 coverage insufficient: ${coverage.reason}`, 503);
  }
  try {
    const result = await runInstStealTrack(date);
    return apiOk({
      market: 'TW', date, universe: result.universe, requestedUniverse: result.requestedUniverse,
      resultCount: result.resultCount, yTrackReadiness: result.readiness, repair: result.repair,
      dataFreshness: {
        status: result.readiness.strategyWindow.coverage === 1 ? 'valid' : 'degraded',
        source: result.readiness.mode,
        coverageRate: result.readiness.strategyWindow.coverage,
        totalStocks: coverage.totalStocks, stocksCurrent: coverage.stocksCurrent,
      },
    });
  } catch (error) {
    return apiError(`Y track failed closed: ${String(error)}`, 503);
  }
}
