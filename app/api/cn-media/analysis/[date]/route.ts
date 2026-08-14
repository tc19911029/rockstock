import { apiError, apiOk } from '@/lib/api/response';
import { validYmd } from '@/lib/cn-media/date';
import {
  aggregateCnMediaMentions,
  loadCnMediaDailyAnalysis,
} from '@/lib/cn-media/analysisStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ date: string }> }) {
  const { date } = await context.params;
  if (!validYmd(date)) return apiError('date must be YYYY-MM-DD', 400);
  const analysis = await loadCnMediaDailyAnalysis(date);
  if (!analysis) return apiOk({ date, analysis: null, stocks: [] });
  return apiOk({ date, analysis, stocks: aggregateCnMediaMentions(analysis) });
}
