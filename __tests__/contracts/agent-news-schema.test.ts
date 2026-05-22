/**
 * Contract test：News Agent answer schema
 *
 * 守的規則（§0 隔離）：
 *   - schemaVersion = 1，agent = 'news'
 *   - verdict ∈ {pass, watch, fail}
 *   - reasoning 3 段（youtube_consensus / rss_news / event_risk）全部齊
 *   - dataPoints ≥ 6 筆，全部 category='news'（**禁止 technical/chip/fundamental**）
 */

import {
  AGENT_SCHEMA_VERSION,
  DataPoint,
  NewsAnswer,
  NEWS_REQUIRED_SECTIONS,
  NewsReasoningItem,
  NewsSection,
} from '@/lib/agents/types';

const MIN_DATAPOINTS = 6;
const FORBIDDEN_CATEGORIES: ReadonlyArray<string> = [
  'technical', 'chip', 'fundamental', 'valuation', 'macro', 'governance', 'industry',
];

function validate(d: unknown): { ok: true } | { ok: false; reason: string } {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not an object' };
  const v = d as Record<string, unknown>;

  if (v.schemaVersion !== AGENT_SCHEMA_VERSION) {
    return { ok: false, reason: `schemaVersion ≠ ${AGENT_SCHEMA_VERSION}` };
  }
  if (v.agent !== 'news') return { ok: false, reason: `agent ≠ 'news'` };
  if (typeof v.runId !== 'string' || !v.runId) return { ok: false, reason: 'runId missing' };
  if (v.verdict !== 'pass' && v.verdict !== 'watch' && v.verdict !== 'fail') {
    return { ok: false, reason: `verdict invalid: ${v.verdict}` };
  }
  if (typeof v.overview !== 'string' || !v.overview) return { ok: false, reason: 'overview missing' };
  if (typeof v.verdictReason !== 'string' || !v.verdictReason) {
    return { ok: false, reason: 'verdictReason missing' };
  }
  if (typeof v.mentioned !== 'boolean') return { ok: false, reason: 'mentioned not boolean' };

  if (!Array.isArray(v.reasoning)) return { ok: false, reason: 'reasoning not array' };
  const sections = new Set((v.reasoning as NewsReasoningItem[]).map((r) => r.section));
  for (const req of NEWS_REQUIRED_SECTIONS) {
    if (!sections.has(req)) return { ok: false, reason: `missing reasoning section: ${req}` };
  }
  for (const item of v.reasoning as NewsReasoningItem[]) {
    if (typeof item.text !== 'string' || item.text.length === 0) {
      return { ok: false, reason: `reasoning.${item.section} text missing` };
    }
    if (!Array.isArray(item.sources)) {
      return { ok: false, reason: `reasoning.${item.section} sources not array` };
    }
  }

  if (!Array.isArray(v.dataPoints)) return { ok: false, reason: 'dataPoints not array' };
  const dps = v.dataPoints as DataPoint[];
  if (dps.length < MIN_DATAPOINTS) {
    return { ok: false, reason: `dataPoints too few: ${dps.length} < ${MIN_DATAPOINTS}` };
  }
  for (let i = 0; i < dps.length; i++) {
    const p = dps[i];
    if (!p || typeof p !== 'object') return { ok: false, reason: `dataPoints[${i}] not object` };
    if (typeof p.category !== 'string') return { ok: false, reason: `dataPoints[${i}].category missing` };
    if (FORBIDDEN_CATEGORIES.includes(p.category)) {
      return {
        ok: false,
        reason: `dataPoints[${i}] category '${p.category}' forbidden for News Agent (violates §0 isolation)`,
      };
    }
    if (p.category !== 'news') {
      return { ok: false, reason: `dataPoints[${i}].category must be 'news' (got ${p.category})` };
    }
    if (typeof p.label !== 'string' || !p.label) return { ok: false, reason: `dataPoints[${i}].label missing` };
    if (typeof p.value !== 'string' || !p.value) return { ok: false, reason: `dataPoints[${i}].value missing` };
    if (typeof p.source !== 'string' || !p.source) return { ok: false, reason: `dataPoints[${i}].source missing` };
  }

  return { ok: true };
}

function makeReasoning(): NewsReasoningItem[] {
  const sources: Record<NewsSection, string[]> = {
    youtube_consensus: ['video-abc123'],
    rss_news:          ['rss-cnyes-456'],
    event_risk:        ['prefetch.youtube'],
  };
  return NEWS_REQUIRED_SECTIONS.map((s) => ({
    section: s,
    text: `${s} 段：根據 prefetch 資料的描述（範例文字 ≥ 30 字之佔位）`,
    sources: sources[s],
  }));
}

function makeDataPoints(n = MIN_DATAPOINTS): DataPoint[] {
  const labels = ['ytMention', 'ytConsensus', 'ytConfidence', 'rssHasNews', 'rssSentiment', 'rssCount'];
  return Array.from({ length: n }, (_, i) => ({
    category: 'news' as const,
    label: labels[i] ?? `news-${i}`,
    value: `${i}`,
    source: `prefetch.youtube.${labels[i] ?? 'field'}`,
    asOf: '2026-05-22',
  }));
}

function makeValid(overrides: Partial<NewsAnswer> = {}): NewsAnswer {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'news',
    runId: 'rid-1',
    date: '2026-05-22',
    symbol: '2330.TW',
    verdict: 'watch',
    overview: 'YouTube 無共識，RSS 有少量正向新聞',
    verdictReason: 'mentionCount=0、aggregateSentiment=0.1',
    reasoning: makeReasoning(),
    dataPoints: makeDataPoints(),
    mentioned: false,
    ...overrides,
  };
}

describe('News Agent answer schema', () => {
  test('合法 answer 通過驗證', () => {
    expect(validate(makeValid())).toEqual({ ok: true });
  });

  test('reasoning 漏掉 event_risk 被 reject', () => {
    const partial = makeReasoning().filter((r) => r.section !== 'event_risk');
    const r = validate({ ...makeValid(), reasoning: partial });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('event_risk');
  });

  test('dataPoints 含 technical category 被 reject（§0 隔離）', () => {
    const dps = makeDataPoints();
    (dps[1] as { category: string }).category = 'technical';
    const r = validate({ ...makeValid(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden for News Agent');
  });

  test('dataPoints 含 chip category 被 reject（§0 隔離）', () => {
    const dps = makeDataPoints();
    (dps[2] as { category: string }).category = 'chip';
    const r = validate({ ...makeValid(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden for News Agent');
  });

  test('dataPoints 不足 6 筆被 reject', () => {
    const r = validate({ ...makeValid(), dataPoints: makeDataPoints(3) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('dataPoints too few');
  });

  test('verdict 非合法值被 reject', () => {
    const r = validate({ ...makeValid(), verdict: 'BUY' });
    expect(r.ok).toBe(false);
  });

  test('mentioned 非 boolean 被 reject', () => {
    const r = validate({ ...makeValid(), mentioned: 'yes' as unknown as boolean });
    expect(r.ok).toBe(false);
  });

  test('reasoning.sources 非 array 被 reject', () => {
    const items = makeReasoning();
    (items[0] as { sources: unknown }).sources = 'video-abc';
    const r = validate({ ...makeValid(), reasoning: items });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('sources not array');
  });
});
