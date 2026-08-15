import type { NDayReturns } from '@/lib/youtube/performance';
import type { CnMediaSource } from './types';

export type CnMediaPerformanceDirection = 'bullish' | 'bearish';
export type CnMediaPerformanceHorizon = 'd1Return' | 'd3Return' | 'd5Return' | 'd10Return' | 'd20Return';

export interface CnMediaRecommendationPerformance {
  date: string;
  source_id: string;
  display_name: string;
  source_tier: CnMediaSource['source_tier'];
  video_id: string;
  stock_code: string;
  stock_symbol: string;
  stock_name: string;
  direction: CnMediaPerformanceDirection;
  reason: string;
  context: string;
  confidence: number;
  raw_performance: NDayReturns;
}

export interface CnMediaHorizonSummary {
  samples: number;
  wins: number;
  hit_rate: number | null;
  avg_return: number | null;
  median_return: number | null;
}

export interface CnMediaProgramPerformance {
  source_id: string;
  display_name: string;
  source_tier: CnMediaSource['source_tier'];
  episode_count: number;
  recommendation_count: number;
  unique_stock_count: number;
  pending_d1_count: number;
  horizons: Record<CnMediaPerformanceHorizon, CnMediaHorizonSummary>;
}

export const CN_MEDIA_PERFORMANCE_HORIZONS: CnMediaPerformanceHorizon[] = [
  'd1Return', 'd3Return', 'd5Return', 'd10Return', 'd20Return',
];

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function directionAdjustedReturn(
  event: CnMediaRecommendationPerformance,
  horizon: CnMediaPerformanceHorizon,
): number | null {
  const raw = event.raw_performance[horizon];
  if (raw == null) return null;
  return round(event.direction === 'bullish' ? raw : -raw);
}

export function summarizeCnMediaHorizon(
  events: CnMediaRecommendationPerformance[],
  horizon: CnMediaPerformanceHorizon,
): CnMediaHorizonSummary {
  const values = events
    .map(event => directionAdjustedReturn(event, horizon))
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  if (!values.length) return { samples: 0, wins: 0, hit_rate: null, avg_return: null, median_return: null };
  const wins = values.filter(value => value > 0).length;
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  return {
    samples: values.length,
    wins,
    hit_rate: round((wins / values.length) * 100),
    avg_return: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    median_return: round(median),
  };
}

export function aggregateCnMediaProgramPerformance(
  sources: CnMediaSource[],
  episodeCounts: Map<string, number>,
  events: CnMediaRecommendationPerformance[],
): CnMediaProgramPerformance[] {
  const sourceById = new Map(sources.map(source => [source.source_id, source]));
  const sourceIds = new Set([...episodeCounts.keys(), ...events.map(event => event.source_id)]);
  return [...sourceIds].map(sourceId => {
    const source = sourceById.get(sourceId);
    const sourceEvents = events.filter(event => event.source_id === sourceId);
    const horizons = Object.fromEntries(CN_MEDIA_PERFORMANCE_HORIZONS.map(horizon => [
      horizon,
      summarizeCnMediaHorizon(sourceEvents, horizon),
    ])) as Record<CnMediaPerformanceHorizon, CnMediaHorizonSummary>;
    return {
      source_id: sourceId,
      display_name: source?.display_name ?? sourceEvents[0]?.display_name ?? sourceId,
      source_tier: source?.source_tier ?? sourceEvents[0]?.source_tier ?? 'creator',
      episode_count: episodeCounts.get(sourceId) ?? 0,
      recommendation_count: sourceEvents.length,
      unique_stock_count: new Set(sourceEvents.map(event => event.stock_code)).size,
      pending_d1_count: sourceEvents.length - horizons.d1Return.samples,
      horizons,
    };
  }).sort((a, b) => {
    const aRate = a.horizons.d1Return.hit_rate ?? -1;
    const bRate = b.horizons.d1Return.hit_rate ?? -1;
    return b.horizons.d1Return.samples - a.horizons.d1Return.samples
      || bRate - aRate
      || b.recommendation_count - a.recommendation_count;
  });
}
