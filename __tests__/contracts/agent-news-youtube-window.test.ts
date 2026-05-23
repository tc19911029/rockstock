/**
 * Contract test：News Agent YouTube prefetch 窗口（T-1 + T 兩日聯集）
 *
 * 守的規則（解決 2026-05-22 矽統 2363.TW case）：
 *   - T-1 盤後節目（如 5/21 23:30 CST published）必須在 T 日（5/22）prefetch 被看見
 *   - 窗口外（早於 T-1 09:00 CST 或晚於 T 24:00 CST）的 mention 必須跳過
 *   - 同一 video_id 重複出現必須 dedup
 *   - 沒有 video_id 或 published_at 的 mention 視為 stale skip
 */

import {
  subDayYmd,
  computeWindow,
  extractYouTubeMentionsInWindow,
  type YouTubeWindow,
} from '@/lib/agents/agents/newsAgent';
import type { DailyAnalysis, AnalyzedStockMention } from '@/lib/youtube/analysisStorage';

function mention(opts: {
  code?: string;
  name?: string;
  videoId: string;
  sentiment?: 'bullish' | 'bearish' | 'neutral';
  confidence?: number;
}): AnalyzedStockMention {
  return {
    raw_query: opts.name ?? opts.code ?? '',
    matched: {
      code: opts.code ?? '2363',
      name: opts.name ?? '矽統',
      market: 'TWSE',
      confidence: 1,
      match_via: 'exact_code',
    },
    llm_confidence: opts.confidence ?? 0.8,
    combined_confidence: opts.confidence ?? 0.64,
    sentiment: opts.sentiment ?? 'bullish',
    context: `示範片段 ${opts.videoId}`,
    reason: '示範理由',
    source_id: 'ustvmoney100',
    video_id: opts.videoId,
  };
}

function analysis(date: string, opts: {
  highConsensus?: AnalyzedStockMention[];
  weakSignal?: AnalyzedStockMention[];
}): DailyAnalysis {
  return {
    date,
    generated_at: `${date}T18:00:00.000Z`,
    market_view: '示範',
    bullish_consensus: [],
    bearish_consensus: [],
    high_consensus_stocks: opts.highConsensus ?? [],
    weak_signal_stocks: opts.weakSignal ?? [],
    stats: {
      videos_analyzed: 0,
      unique_stocks_total: 0,
      high_consensus_count: 0,
      weak_signal_count: 0,
    },
  };
}

describe('News Agent YouTube prefetch window', () => {
  describe('subDayYmd / computeWindow', () => {
    test('subDayYmd 退一天', () => {
      expect(subDayYmd('2026-05-22')).toBe('2026-05-21');
      expect(subDayYmd('2026-01-01')).toBe('2025-12-31');
      expect(subDayYmd('2026-03-01')).toBe('2026-02-28');
    });

    test('computeWindow = [T-1 01:00 UTC, T 16:00 UTC]', () => {
      const w = computeWindow('2026-05-22');
      expect(w.startUtcIso).toBe('2026-05-21T01:00:00.000Z');
      expect(w.endUtcIso).toBe('2026-05-22T16:00:00.000Z');
    });

    test('窗口含 5/21 23:30 CST published（矽統 case）', () => {
      // 5/21 23:30 CST = 5/21 15:30 UTC
      const pub = new Date('2026-05-21T15:30:14.000Z').getTime();
      const w = computeWindow('2026-05-22');
      const start = new Date(w.startUtcIso).getTime();
      const end = new Date(w.endUtcIso).getTime();
      expect(pub >= start && pub <= end).toBe(true);
    });

    test('窗口排除 T-2 的提及（過期）', () => {
      // 5/20 12:00 CST = 5/20 04:00 UTC
      const pub = new Date('2026-05-20T04:00:00.000Z').getTime();
      const w = computeWindow('2026-05-22');
      const start = new Date(w.startUtcIso).getTime();
      expect(pub < start).toBe(true);
    });
  });

  describe('extractYouTubeMentionsInWindow', () => {
    test('矽統 case：5/21 23:30 提及 → 5/22 prefetch 應該看到', () => {
      const m = mention({ videoId: 'PSblbWLfqx0', confidence: 0.64 });
      const win: YouTubeWindow = {
        dates: ['2026-05-21', '2026-05-22'],
        yesterdayAnalysis: analysis('2026-05-21', { weakSignal: [m] }),
        todayAnalysis: analysis('2026-05-22', {}),
        publishedAtMap: new Map([['PSblbWLfqx0', '2026-05-21T15:30:14.000Z']]),
        ...computeWindow('2026-05-22'),
      };
      const r = extractYouTubeMentionsInWindow(win, '2363.TW', '矽統');
      expect(r.mentionCount).toBe(1);
      expect(r.videoIds).toContain('PSblbWLfqx0');
      expect(r.windowDates).toEqual(['2026-05-21', '2026-05-22']);
      expect(r.publishedAtWindow?.startUtc).toBe('2026-05-21T01:00:00.000Z');
    });

    test('窗口外的提及（T-2）必須跳過', () => {
      const m = mention({ videoId: 'old-vid' });
      const win: YouTubeWindow = {
        dates: ['2026-05-21', '2026-05-22'],
        yesterdayAnalysis: analysis('2026-05-21', { weakSignal: [m] }),
        todayAnalysis: null,
        publishedAtMap: new Map([['old-vid', '2026-05-20T04:00:00.000Z']]),
        ...computeWindow('2026-05-22'),
      };
      const r = extractYouTubeMentionsInWindow(win, '2363.TW', '矽統');
      expect(r.mentionCount).toBe(0);
      expect(r.videoIds).toEqual([]);
    });

    test('沒有 published_at 的 mention 視為 stale skip', () => {
      const m = mention({ videoId: 'no-pub' });
      const win: YouTubeWindow = {
        dates: ['2026-05-21', '2026-05-22'],
        yesterdayAnalysis: analysis('2026-05-21', { weakSignal: [m] }),
        todayAnalysis: null,
        publishedAtMap: new Map(),  // 空 map
        ...computeWindow('2026-05-22'),
      };
      const r = extractYouTubeMentionsInWindow(win, '2363.TW', '矽統');
      expect(r.mentionCount).toBe(0);
    });

    test('同一 video_id 重複出現 dedup（取 confidence 較高）', () => {
      const m1 = mention({ videoId: 'dup-vid', confidence: 0.5 });
      const m2 = mention({ videoId: 'dup-vid', confidence: 0.9 });
      const win: YouTubeWindow = {
        dates: ['2026-05-21', '2026-05-22'],
        yesterdayAnalysis: analysis('2026-05-21', { weakSignal: [m1] }),
        todayAnalysis: analysis('2026-05-22', { weakSignal: [m2] }),
        publishedAtMap: new Map([['dup-vid', '2026-05-22T03:00:00.000Z']]),
        ...computeWindow('2026-05-22'),
      };
      const r = extractYouTubeMentionsInWindow(win, '2363.TW', '矽統');
      expect(r.mentionCount).toBe(1);
      expect(r.combinedConfidence).toBeCloseTo(0.9, 2);
    });

    test('inHighConsensus 來自 T-1 high_consensus 也算', () => {
      const m = mention({ videoId: 'hc-vid' });
      const win: YouTubeWindow = {
        dates: ['2026-05-21', '2026-05-22'],
        yesterdayAnalysis: analysis('2026-05-21', { highConsensus: [m] }),
        todayAnalysis: null,
        publishedAtMap: new Map([['hc-vid', '2026-05-21T15:00:00.000Z']]),
        ...computeWindow('2026-05-22'),
      };
      const r = extractYouTubeMentionsInWindow(win, '2363.TW', '矽統');
      expect(r.inHighConsensus).toBe(true);
    });

    test('完全沒有 mention 時回傳空結構但帶 windowDates', () => {
      const win: YouTubeWindow = {
        dates: ['2026-05-21', '2026-05-22'],
        yesterdayAnalysis: analysis('2026-05-21', {}),
        todayAnalysis: analysis('2026-05-22', {}),
        publishedAtMap: new Map(),
        ...computeWindow('2026-05-22'),
      };
      const r = extractYouTubeMentionsInWindow(win, '2363.TW', '矽統');
      expect(r.mentionCount).toBe(0);
      expect(r.windowDates).toEqual(['2026-05-21', '2026-05-22']);
      expect(r.publishedAtWindow).toBeDefined();
    });

    test('sentiment 多數決 — 兩 bullish 一 bearish → bullish', () => {
      const m1 = mention({ videoId: 'v1', sentiment: 'bullish' });
      const m2 = mention({ videoId: 'v2', sentiment: 'bullish' });
      const m3 = mention({ videoId: 'v3', sentiment: 'bearish' });
      const win: YouTubeWindow = {
        dates: ['2026-05-21', '2026-05-22'],
        yesterdayAnalysis: analysis('2026-05-21', { weakSignal: [m1, m2, m3] }),
        todayAnalysis: null,
        publishedAtMap: new Map([
          ['v1', '2026-05-21T15:00:00.000Z'],
          ['v2', '2026-05-21T16:00:00.000Z'],
          ['v3', '2026-05-21T17:00:00.000Z'],
        ]),
        ...computeWindow('2026-05-22'),
      };
      const r = extractYouTubeMentionsInWindow(win, '2363.TW', '矽統');
      expect(r.mentionCount).toBe(3);
      expect(r.sentiment).toBe('bullish');
    });
  });
});
