/**
 * Contract test：Candidates Pool 結構 + Source 隔離
 *
 * 守的規則：
 *   - mergeCandidates 同 symbol 正確合併
 *   - sourceCount 正確
 *   - 排序：sourceCount DESC → weightedStrength DESC → symbol asc
 *   - sliceSourcesForAgent 對每個 agent 只給對應面向（§0 isolation 機制）
 */

import { mergeCandidates } from '@/lib/agents/candidates/merger';
import { sliceSourcesForAgent, VISIBLE_SOURCE_BY_AGENT } from '@/lib/agents/candidates/types';
import type {
  CandidateSources,
  ChipSourceAttribution,
  FundamentalSourceAttribution,
  SourceResult,
  TechnicalSourceAttribution,
  YouTubeSourceAttribution,
} from '@/lib/agents/candidates/types';

const techAttr = (tracks: string[], score: number): TechnicalSourceAttribution => ({
  matchedMethods: tracks, sixConditionsScore: score, tracks, reasons: [],
  prohibitionHit: false, eliminationHit: false,
});
const ytAttr = (mentions: number, sentiment = 'bullish'): YouTubeSourceAttribution => ({
  mentionCount: mentions, shows: ['ustvmoney100'], sentiment,
  inHighConsensus: mentions >= 2, combinedConfidence: 0.8, reasons: [],
});
const chipAttr = (score: number): ChipSourceAttribution => ({
  chipScore: score, signals: ['foreign_strong_buy'], reasons: [],
});
const fundAttr = (yoy: number): FundamentalSourceAttribution => ({
  revenueYoY: yoy, epsYoY: null, grossMargin: 30, signals: ['revenue_yoy_high'], reasons: [],
});

function makeSourceResult(source: 'technical' | 'youtube' | 'chip' | 'fundamental', items: Array<{ symbol: string; attribution: unknown }>): SourceResult {
  return {
    source,
    ran: true,
    candidates: items.map((i) => ({
      symbol: i.symbol,
      name: `${i.symbol} 公司`,
      market: 'TW' as const,
      attribution: i.attribution as CandidateSources[typeof source],
    })),
  };
}

describe('Candidates Pool — mergeCandidates', () => {
  test('同 symbol 跨 source 合併', () => {
    const pool = mergeCandidates({
      market: 'TW', date: '2026-05-22',
      results: [
        makeSourceResult('technical', [{ symbol: '2330.TW', attribution: techAttr(['A', 'B'], 6) }]),
        makeSourceResult('youtube',   [{ symbol: '2330.TW', attribution: ytAttr(3) }]),
      ],
    });
    expect(pool.candidates).toHaveLength(1);
    const c = pool.candidates[0];
    expect(c.symbol).toBe('2330.TW');
    expect(c.sourceCount).toBe(2);
    expect(c.sources.technical).toBeDefined();
    expect(c.sources.youtube).toBeDefined();
    expect(c.sources.chip).toBeUndefined();
  });

  test('4 個 source 全命中 → sourceCount=4', () => {
    const pool = mergeCandidates({
      market: 'TW', date: '2026-05-22',
      results: [
        makeSourceResult('technical', [{ symbol: '2330.TW', attribution: techAttr(['A'], 6) }]),
        makeSourceResult('youtube',   [{ symbol: '2330.TW', attribution: ytAttr(2) }]),
        makeSourceResult('chip',      [{ symbol: '2330.TW', attribution: chipAttr(80) }]),
        makeSourceResult('fundamental', [{ symbol: '2330.TW', attribution: fundAttr(20) }]),
      ],
    });
    expect(pool.candidates[0].sourceCount).toBe(4);
  });

  test('排序：sourceCount 高的在前', () => {
    const pool = mergeCandidates({
      market: 'TW', date: '2026-05-22',
      results: [
        makeSourceResult('technical', [
          { symbol: '1111.TW', attribution: techAttr(['A'], 5) },
          { symbol: '2222.TW', attribution: techAttr(['A', 'B', 'C'], 6) },
        ]),
        makeSourceResult('youtube', [
          { symbol: '2222.TW', attribution: ytAttr(3) },
        ]),
      ],
    });
    expect(pool.candidates[0].symbol).toBe('2222.TW');  // sourceCount=2
    expect(pool.candidates[1].symbol).toBe('1111.TW');  // sourceCount=1
  });

  test('source 失敗不影響其他', () => {
    const pool = mergeCandidates({
      market: 'TW', date: '2026-05-22',
      results: [
        makeSourceResult('technical', [{ symbol: '2330.TW', attribution: techAttr(['A'], 6) }]),
        { source: 'youtube', ran: false, error: 'unavailable', candidates: [] },
        makeSourceResult('chip', [{ symbol: '2330.TW', attribution: chipAttr(80) }]),
        { source: 'fundamental', ran: false, error: 'timeout', candidates: [] },
      ],
    });
    expect(pool.sourceStatus.youtube.ran).toBe(false);
    expect(pool.sourceStatus.youtube.error).toBe('unavailable');
    expect(pool.sourceStatus.fundamental.error).toBe('timeout');
    expect(pool.candidates[0].sourceCount).toBe(2);
  });

  test('schemaVersion + generatedAt 必填', () => {
    const pool = mergeCandidates({
      market: 'TW', date: '2026-05-22',
      results: [makeSourceResult('technical', [{ symbol: '2330.TW', attribution: techAttr(['A'], 6) }])],
    });
    expect(pool.schemaVersion).toBe(1);
    expect(typeof pool.generatedAt).toBe('string');
    expect(pool.generatedAt.length).toBeGreaterThan(0);
  });
});

describe('Candidates — sliceSourcesForAgent (§0 isolation)', () => {
  const fullSources: CandidateSources = {
    technical: techAttr(['A'], 6),
    youtube: ytAttr(3),
    chip: chipAttr(80),
    fundamental: fundAttr(20),
  };

  test('Technical agent 只看 technical source', () => {
    const sliced = sliceSourcesForAgent(fullSources, 'technical');
    expect(sliced.technical).toBeDefined();
    expect(sliced.youtube).toBeUndefined();
    expect(sliced.chip).toBeUndefined();
    expect(sliced.fundamental).toBeUndefined();
  });

  test('News agent 只看 youtube source', () => {
    const sliced = sliceSourcesForAgent(fullSources, 'news');
    expect(sliced.youtube).toBeDefined();
    expect(sliced.technical).toBeUndefined();
    expect(sliced.chip).toBeUndefined();
    expect(sliced.fundamental).toBeUndefined();
  });

  test('Chip agent 只看 chip source', () => {
    const sliced = sliceSourcesForAgent(fullSources, 'chip');
    expect(sliced.chip).toBeDefined();
    expect(sliced.technical).toBeUndefined();
    expect(sliced.youtube).toBeUndefined();
    expect(sliced.fundamental).toBeUndefined();
  });

  test('Fundamental agent 只看 fundamental source', () => {
    const sliced = sliceSourcesForAgent(fullSources, 'fundamental');
    expect(sliced.fundamental).toBeDefined();
    expect(sliced.technical).toBeUndefined();
    expect(sliced.youtube).toBeUndefined();
    expect(sliced.chip).toBeUndefined();
  });

  test('Decision agent (P4) 可以看全部 sources', () => {
    const sliced = sliceSourcesForAgent(fullSources, 'decision');
    expect(sliced.technical).toBeDefined();
    expect(sliced.youtube).toBeDefined();
    expect(sliced.chip).toBeDefined();
    expect(sliced.fundamental).toBeDefined();
  });

  test('VISIBLE_SOURCE_BY_AGENT 白名單 sanity', () => {
    expect(VISIBLE_SOURCE_BY_AGENT.technical).toEqual(['technical']);
    expect(VISIBLE_SOURCE_BY_AGENT.news).toEqual(['youtube']);
    expect(VISIBLE_SOURCE_BY_AGENT.chip).toEqual(['chip']);
    expect(VISIBLE_SOURCE_BY_AGENT.fundamental).toEqual(['fundamental']);
    expect(VISIBLE_SOURCE_BY_AGENT.decision).toContain('technical');
    expect(VISIBLE_SOURCE_BY_AGENT.decision).toContain('youtube');
  });

  test('部分 sources 缺失時 slice 不會回 undefined 鍵', () => {
    const partial: CandidateSources = { technical: techAttr(['A'], 6) };
    const sliced = sliceSourcesForAgent(partial, 'technical');
    expect(sliced.technical).toBeDefined();
    // 沒設定的不會出現在 key 列表中
    expect(Object.keys(sliced)).toEqual(['technical']);
  });
});
