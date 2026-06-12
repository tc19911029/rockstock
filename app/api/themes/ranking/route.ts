/**
 * 板塊（題材）強弱排名查詢（2026-06-12 A2）
 * GET /api/themes/ranking[?date=YYYY-MM-DD]
 * 不帶 date：回最近 7 天內最新一份；帶 date：回該日（無檔 404）。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { readSectorRanking, readLatestSectorRanking } from '@/lib/themes/sectorRanking';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  const file = date ? await readSectorRanking(date) : await readLatestSectorRanking();
  if (!file) {
    return apiError(date ? `no sector ranking for ${date}` : 'no sector ranking available (cron not run yet)', 404);
  }
  return apiOk(file);
}
