/**
 * 每日選股漏斗 API（2026-06-13）— /daily-pick 頁面消費。
 * GET /api/daily-pick[?date=YYYY-MM-DD]（預設最近交易日）
 * 邏輯單一事實在 lib/dailyPick/buildDailyPick.ts（與 scripts/daily-pick.ts 共用）。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { buildDailyPick } from '@/lib/dailyPick/buildDailyPick';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date') ?? getLastTradingDay('TW');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return apiError('bad date', 400);
  try {
    return apiOk(await buildDailyPick(date));
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err), 500);
  }
}
