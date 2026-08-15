import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { computeNDayReturns } from '@/lib/youtube/performance';
import { loadCnMediaDailyAnalysis } from '@/lib/cn-media/analysisStorage';
import {
  aggregateCnMediaProgramPerformance,
  type CnMediaPerformanceDirection,
  type CnMediaRecommendationPerformance,
} from '@/lib/cn-media/performance';
import { loadCnMediaSources, loadCnMediaVideos } from '@/lib/cn-media/storage';
import type { CnMediaMention } from '@/lib/cn-media/analysisStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T12:00:00+08:00`);
  const end = new Date(`${to}T12:00:00+08:00`);
  while (cursor <= end && dates.length <= 120) {
    dates.push(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function direction(mention: CnMediaMention): CnMediaPerformanceDirection | null {
  if (mention.sentiment === 'bullish') return 'bullish';
  if (mention.sentiment === 'bearish' || mention.sentiment === 'risk_warning') return 'bearish';
  return null;
}

export async function GET(request: NextRequest) {
  const from = request.nextUrl.searchParams.get('from') ?? '2026-08-10';
  const to = request.nextUrl.searchParams.get('to') ?? from;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    return apiError('from/to must be a valid ascending YYYY-MM-DD range', 400);
  }
  const dates = dateRange(from, to);
  if (!dates.length || dates.length > 120) return apiError('date range must be 1-120 days', 400);

  try {
    const [sources, daily] = await Promise.all([
      loadCnMediaSources(),
      Promise.all(dates.map(async date => ({
        date,
        analysis: await loadCnMediaDailyAnalysis(date),
        videos: await loadCnMediaVideos(date),
      }))),
    ]);
    const sourceById = new Map(sources.map(source => [source.source_id, source]));
    const episodeCounts = new Map<string, number>();
    const candidateByKey = new Map<string, { mention: CnMediaMention; date: string; conflicted: boolean }>();

    for (const day of daily) {
      for (const video of day.videos) episodeCounts.set(video.source_id, (episodeCounts.get(video.source_id) ?? 0) + 1);
      if (!day.analysis) continue;
      const mentions = [...day.analysis.high_consensus_stocks, ...day.analysis.weak_signal_stocks];
      for (const mention of mentions) {
        const mentionDirection = direction(mention);
        if (!mention.matched || mention.combined_confidence < 0.6 || !mentionDirection) continue;
        const key = `${day.date}|${mention.source_id}|${mention.matched.code}`;
        const existing = candidateByKey.get(key);
        if (existing && direction(existing.mention) !== mentionDirection) {
          existing.conflicted = true;
          continue;
        }
        if (!existing || mention.combined_confidence > existing.mention.combined_confidence) {
          candidateByKey.set(key, { mention, date: day.date, conflicted: existing?.conflicted ?? false });
        }
      }
    }

    const candleCache = new Map<string, Awaited<ReturnType<typeof loadLocalCandles>>>();
    const events: CnMediaRecommendationPerformance[] = [];
    for (const candidate of candidateByKey.values()) {
      if (candidate.conflicted || !candidate.mention.matched) continue;
      const mention = candidate.mention;
      const mentionDirection = direction(mention);
      const matched = mention.matched;
      if (!mentionDirection || !matched) continue;
      const symbol = matched.symbol;
      if (!candleCache.has(symbol)) candleCache.set(symbol, await loadLocalCandles(symbol, 'CN'));
      const candles = candleCache.get(symbol);
      const source = sourceById.get(mention.source_id);
      events.push({
        date: candidate.date,
        source_id: mention.source_id,
        display_name: source?.display_name ?? mention.source_id,
        source_tier: source?.source_tier ?? 'creator',
        video_id: mention.video_id,
        stock_code: matched.code,
        stock_symbol: symbol,
        stock_name: matched.name,
        direction: mentionDirection,
        reason: mention.reason,
        context: mention.context,
        confidence: mention.combined_confidence,
        raw_performance: candles ? computeNDayReturns(candles, candidate.date) : computeNDayReturns([], candidate.date),
      });
    }

    return apiOk({
      from,
      to,
      generated_at: new Date().toISOString(),
      methodology: '同節目同日同股去重；看多採股票報酬、看空採反向報酬；命中為方向調整後報酬大於 0。',
      analysis_dates: daily.filter(day => day.analysis).map(day => day.date),
      missing_analysis_dates: daily.filter(day => day.videos.length > 0 && !day.analysis).map(day => day.date),
      episode_count: daily.reduce((sum, day) => sum + day.videos.length, 0),
      recommendation_count: events.length,
      programs: aggregateCnMediaProgramPerformance(sources, episodeCounts, events),
      events: events.sort((a, b) => b.date.localeCompare(a.date) || b.confidence - a.confidence),
    });
  } catch (error) {
    return apiError(`cn-media performance failed: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
}
