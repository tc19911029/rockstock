/**
 * GET /api/broker/reports/[date]
 *
 * 回傳某日所有券商報告（data/broker/reports/{date}.json）。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { loadDailyReports } from '@/lib/broker/brokerStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ date: string }> },
) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError('date must be YYYY-MM-DD', 400);
  }
  try {
    const day = await loadDailyReports(date);
    if (!day) {
      return apiOk({ date, reports: [], message: '此日無券商報告' });
    }
    return apiOk(day);
  } catch (err) {
    return apiError(`loadDailyReports failed: ${(err as Error).message}`, 500);
  }
}
