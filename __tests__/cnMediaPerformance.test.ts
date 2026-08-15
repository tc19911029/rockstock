import {
  aggregateCnMediaProgramPerformance,
  directionAdjustedReturn,
  summarizeCnMediaHorizon,
  type CnMediaRecommendationPerformance,
} from '@/lib/cn-media/performance';
import type { CnMediaSource } from '@/lib/cn-media/types';
import type { NDayReturns } from '@/lib/youtube/performance';

const basePerformance: NDayReturns = {
  status: 'stale', baseClose: 10, openReturn: null,
  d1Return: null, d2Return: null, d3Return: null, d4Return: null, d5Return: null,
  d6Return: null, d7Return: null, d8Return: null, d9Return: null, d10Return: null,
  d20Return: null, maxGain: null, maxLoss: null,
};

function event(direction: 'bullish' | 'bearish', d1Return: number | null): CnMediaRecommendationPerformance {
  return {
    date: '2026-08-10', source_id: 'show', display_name: '節目', source_tier: 'official_media',
    video_id: 'v1', stock_code: '600000', stock_symbol: '600000.SS', stock_name: '測試股',
    direction, reason: '測試', context: '測試', confidence: 0.9,
    raw_performance: { ...basePerformance, d1Return },
  };
}

describe('陸股節目績效', () => {
  test('看空推薦使用反向報酬', () => {
    expect(directionAdjustedReturn(event('bullish', 3), 'd1Return')).toBe(3);
    expect(directionAdjustedReturn(event('bearish', 3), 'd1Return')).toBe(-3);
  });

  test('只用已成熟樣本計算命中率與平均報酬', () => {
    expect(summarizeCnMediaHorizon([
      event('bullish', 4), event('bearish', -2), event('bullish', null), event('bullish', -3),
    ], 'd1Return')).toEqual({
      samples: 3, wins: 2, hit_rate: 66.67, avg_return: 1, median_return: 2,
    });
  });

  test('有播出但沒有明確多空推薦的節目仍列入排行榜', () => {
    const sources: CnMediaSource[] = [{
      source_id: 'show', display_name: '節目', platform: 'yicai', url: 'https://example.com',
      expected_cadence: 'weekday', active: true, default_analysts: [], source_tier: 'official_media',
    }];
    const rows = aggregateCnMediaProgramPerformance(sources, new Map([['show', 2]]), []);
    expect(rows[0]).toMatchObject({ episode_count: 2, recommendation_count: 0, pending_d1_count: 0 });
  });
});
