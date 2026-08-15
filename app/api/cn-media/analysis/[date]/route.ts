import { apiError, apiOk } from '@/lib/api/response';
import { validYmd } from '@/lib/cn-media/date';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { injectL2TodayIfNeeded } from '@/lib/datasource/injectL2Today';
import { computeNDayReturns } from '@/lib/youtube/performance';
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
  const stocks = await Promise.all(aggregateCnMediaMentions(analysis).map(async stock => {
    const symbol = stock.mentions.find(mention => mention.matched)?.matched?.symbol;
    if (!symbol) return { ...stock, performance: computeNDayReturns([], date) };
    let candles = await loadLocalCandles(symbol, 'CN');
    candles = await injectL2TodayIfNeeded(candles, symbol, 'CN', date);
    return {
      ...stock,
      performance: computeNDayReturns(candles ?? [], date),
    };
  }));
  return apiOk({ date, analysis, stocks });
}
