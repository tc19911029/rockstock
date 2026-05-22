/**
 * GET /api/youtube/stocks?date=YYYY-MM-DD
 *
 * 從 Claude 寫的 DailyAnalysis (data/youtube/analysis/{date}.json) 衍生
 * 「今日提到的股票」表格（前端 /youtube 用）。
 *
 * 沒有 analysis 檔時回 stocks=[] + message。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { deriveStockMentions, loadDailyAnalysis } from '@/lib/youtube/analysisStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayYmdTaipei(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError('date must be YYYY-MM-DD', 400);
  }

  try {
    const analysis = await loadDailyAnalysis(date);
    if (!analysis) {
      return apiOk({
        date, total_unique_stocks: 0, stocks: [],
        message: 'no analysis for this date — run /youtube-analysis skill',
      });
    }
    return apiOk(deriveStockMentions(analysis));
  } catch (err) {
    return apiError(`deriveStockMentions failed: ${(err as Error).message}`, 500);
  }
}
