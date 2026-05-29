/**
 * GET /api/strategies/fundamental-revaluation?market=TW&date=YYYY-MM-DD
 *
 * 讀 Phase 1 session + Phase 2 deep（如果存在）合併回傳。
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { loadSession, loadDeepSession } from '@/lib/strategy/fundamentalRevaluation/storage';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const marketParam = (req.nextUrl.searchParams.get('market') ?? 'TW').toUpperCase();
  if (marketParam !== 'TW' && marketParam !== 'CN') {
    return apiError(`invalid market: ${marketParam}`);
  }
  const market = marketParam as 'TW' | 'CN';
  const date = req.nextUrl.searchParams.get('date') ?? getLastTradingDay(market);

  try {
    const [session, deep] = await Promise.all([
      loadSession(market, date),
      loadDeepSession(market, date),
    ]);

    if (!session) {
      return apiOk({
        market,
        date,
        session: null,
        deep: null,
        message: 'no session for this date',
      });
    }

    return apiOk({
      market,
      date,
      session,
      deep,
    });
  } catch (err) {
    return apiError(String(err));
  }
}
