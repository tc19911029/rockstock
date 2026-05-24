/**
 * GET /api/youtube/stocks/[code]/history?range=30d
 *
 * 個股跨日歷史（MVP 6）— 該股 30 天內所有被提到的時刻 + 評級變化。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { buildStockHistory, loadAnalysesInRange } from '@/lib/youtube/historicalAggregator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RANGE_MAP: Record<string, number> = { '7d': 7, '14d': 14, '30d': 30, '90d': 90 };

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
) {
  const { code } = await ctx.params;
  if (!/^[0-9A-Z\-]{3,8}$/i.test(code)) {
    return apiError('code must be 3-8 alphanumeric chars', 400);
  }

  const url = new URL(req.url);
  const rangeKey = url.searchParams.get('range') || '30d';
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
        ...meta, stock_code: code, history: null,
        message: 'no analyses found in this range',
      });
    }
    const history = await buildStockHistory(analyses, code);
    if (!history) {
      return apiOk({
        ...meta, stock_code: code, history: null,
        message: 'this stock was never mentioned in the range',
      });
    }
    return apiOk({ ...meta, history });
  } catch (err) {
    return apiError(`buildStockHistory failed: ${(err as Error).message}`, 500);
  }
}
