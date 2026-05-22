/**
 * GET /api/youtube/trends?range=7d|30d&end_date=YYYY-MM-DD
 *
 * 跨日 stock-level 排行（MVP 6）。
 * 預設 range=7d、end_date=今日 (Asia/Taipei)。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { aggregateStockTrends, loadAnalysesInRange } from '@/lib/youtube/historicalAggregator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RANGE_MAP: Record<string, number> = { '7d': 7, '14d': 14, '30d': 30 };

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const rangeKey = url.searchParams.get('range') || '7d';
  const endDate = url.searchParams.get('end_date') || todayYmdTaipei(new Date());
  const rangeDays = RANGE_MAP[rangeKey];

  if (!rangeDays) {
    return apiError(`range must be one of: ${Object.keys(RANGE_MAP).join(', ')}`, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return apiError('end_date must be YYYY-MM-DD', 400);
  }

  try {
    const { meta, analyses } = await loadAnalysesInRange(endDate, rangeDays);
    if (analyses.length === 0) {
      return apiOk({
        ...meta, stocks: [],
        message: 'no analyses found in this range',
      });
    }
    const stocks = aggregateStockTrends(analyses);
    return apiOk({ ...meta, total_stocks: stocks.length, stocks });
  } catch (err) {
    return apiError(`aggregate failed: ${(err as Error).message}`, 500);
  }
}
