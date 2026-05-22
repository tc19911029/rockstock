/**
 * GET /api/youtube/analysis/[date]
 *
 * 回傳 Claude 寫的當日分析 (data/youtube/analysis/{date}.json)。
 *
 * 路徑 date 用 YYYY-MM-DD（Asia/Taipei）。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { loadDailyAnalysis } from '@/lib/youtube/analysisStorage';

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
    const analysis = await loadDailyAnalysis(date);
    if (!analysis) {
      return apiOk({
        analysis: null,
        message: 'no analysis for this date — run /youtube-analysis skill after question payload is prepared',
      });
    }
    return apiOk({ analysis });
  } catch (err) {
    return apiError(`loadDailyAnalysis failed: ${(err as Error).message}`, 500);
  }
}
