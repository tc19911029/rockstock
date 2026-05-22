/**
 * Contract test：Fundamental Agent answer schema
 *
 * 守的規則（§0 隔離）：
 *   - schemaVersion = 1，agent = 'fundamental'
 *   - reasoning 4 段（revenue / profit / valuation / industry）
 *   - dataPoints ≥ 6 fundamental + ≥ 2 valuation；允許 industry
 *     **禁止 technical / chip / news / macro / governance**
 */

import {
  AGENT_SCHEMA_VERSION,
  DataPoint,
  FundamentalAnswer,
  FUNDAMENTAL_REQUIRED_SECTIONS,
  FundamentalReasoningItem,
  FundamentalSection,
} from '@/lib/agents/types';

const MIN_FUNDAMENTAL = 6;
const MIN_VALUATION = 2;
const ALLOWED: ReadonlyArray<string> = ['fundamental', 'valuation', 'industry'];
const FORBIDDEN: ReadonlyArray<string> = [
  'technical', 'chip', 'news', 'macro', 'governance',
];

function validate(d: unknown): { ok: true } | { ok: false; reason: string } {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not an object' };
  const v = d as Record<string, unknown>;

  if (v.schemaVersion !== AGENT_SCHEMA_VERSION) return { ok: false, reason: `schemaVersion ≠ 1` };
  if (v.agent !== 'fundamental') return { ok: false, reason: `agent ≠ 'fundamental'` };
  if (v.verdict !== 'pass' && v.verdict !== 'watch' && v.verdict !== 'fail') {
    return { ok: false, reason: `verdict invalid: ${v.verdict}` };
  }
  if (typeof v.overview !== 'string' || !v.overview) return { ok: false, reason: 'overview missing' };
  if (typeof v.verdictReason !== 'string' || !v.verdictReason) {
    return { ok: false, reason: 'verdictReason missing' };
  }

  if (!Array.isArray(v.reasoning)) return { ok: false, reason: 'reasoning not array' };
  const sections = new Set((v.reasoning as FundamentalReasoningItem[]).map((r) => r.section));
  for (const req of FUNDAMENTAL_REQUIRED_SECTIONS) {
    if (!sections.has(req)) return { ok: false, reason: `missing reasoning section: ${req}` };
  }
  for (const item of v.reasoning as FundamentalReasoningItem[]) {
    if (typeof item.text !== 'string' || !item.text) {
      return { ok: false, reason: `reasoning.${item.section} text missing` };
    }
    if (!Array.isArray(item.sources)) {
      return { ok: false, reason: `reasoning.${item.section} sources not array` };
    }
  }

  if (!Array.isArray(v.dataPoints)) return { ok: false, reason: 'dataPoints not array' };
  const dps = v.dataPoints as DataPoint[];
  let fundCount = 0, valCount = 0;
  for (let i = 0; i < dps.length; i++) {
    const p = dps[i];
    if (FORBIDDEN.includes(p.category)) {
      return { ok: false, reason: `dataPoints[${i}] category '${p.category}' forbidden for Fundamental Agent (violates §0 isolation)` };
    }
    if (!ALLOWED.includes(p.category)) {
      return { ok: false, reason: `dataPoints[${i}] category '${p.category}' not allowed` };
    }
    if (typeof p.label !== 'string' || !p.label) return { ok: false, reason: `dataPoints[${i}].label missing` };
    if (typeof p.value !== 'string' || !p.value) return { ok: false, reason: `dataPoints[${i}].value missing` };
    if (typeof p.source !== 'string' || !p.source) return { ok: false, reason: `dataPoints[${i}].source missing` };
    if (p.category === 'fundamental') fundCount++;
    if (p.category === 'valuation') valCount++;
  }
  if (fundCount < MIN_FUNDAMENTAL) {
    return { ok: false, reason: `fundamental dataPoints too few: ${fundCount} < ${MIN_FUNDAMENTAL}` };
  }
  if (valCount < MIN_VALUATION) {
    return { ok: false, reason: `valuation dataPoints too few: ${valCount} < ${MIN_VALUATION}` };
  }

  return { ok: true };
}

function makeReasoning(): FundamentalReasoningItem[] {
  const sources: Record<FundamentalSection, string[]> = {
    revenue:   ['prefetch.fundamentals.revenueYoY'],
    profit:    ['prefetch.fundamentals.eps'],
    valuation: ['prefetch.fundamentals.per'],
    industry:  ['groundTruth.industry'],
  };
  return FUNDAMENTAL_REQUIRED_SECTIONS.map((s) => ({
    section: s,
    text: `${s} 段：依 prefetch 基本面欄位判斷（範例文字 ≥ 30 字之佔位）`,
    sources: sources[s],
  }));
}

function makeDataPoints(fund = MIN_FUNDAMENTAL, val = MIN_VALUATION, ind = 1): DataPoint[] {
  const out: DataPoint[] = [];
  const fLabels = ['eps', 'epsYoY', 'grossMargin', 'netMargin', 'revenueLatest', 'revenueYoY', 'revenueMoM'];
  for (let i = 0; i < fund; i++) {
    out.push({ category: 'fundamental', label: fLabels[i] ?? `f-${i}`, value: `${i}`, source: 'prefetch.fundamentals', asOf: '2026Q1' });
  }
  const vLabels = ['per', 'pbr', 'dividendYield'];
  for (let i = 0; i < val; i++) {
    out.push({ category: 'valuation', label: vLabels[i] ?? `v-${i}`, value: `${i * 10}`, source: 'prefetch.fundamentals' });
  }
  for (let i = 0; i < ind; i++) {
    out.push({ category: 'industry', label: '產業', value: '半導體', source: 'L4.candidateRow.industry' });
  }
  return out;
}

function makeValid(overrides: Partial<FundamentalAnswer> = {}): FundamentalAnswer {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'fundamental',
    runId: 'rid-1',
    date: '2026-05-22',
    symbol: '2330.TW',
    verdict: 'pass',
    overview: 'EPS YoY +25%，PER 合理',
    verdictReason: '營收與獲利雙成長',
    reasoning: makeReasoning(),
    dataPoints: makeDataPoints(),
    ...overrides,
  };
}

describe('Fundamental Agent answer schema', () => {
  test('合法 answer 通過驗證', () => {
    expect(validate(makeValid())).toEqual({ ok: true });
  });

  test('reasoning 漏掉 industry 段被 reject', () => {
    const partial = makeReasoning().filter((r) => r.section !== 'industry');
    const r = validate({ ...makeValid(), reasoning: partial });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('industry');
  });

  test('dataPoints 含 technical category 被 reject（§0 隔離）', () => {
    const dps = makeDataPoints();
    (dps[0] as { category: string }).category = 'technical';
    const r = validate({ ...makeValid(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden for Fundamental Agent');
  });

  test('dataPoints 含 chip category 被 reject（§0 隔離）', () => {
    const dps = makeDataPoints();
    (dps[2] as { category: string }).category = 'chip';
    const r = validate({ ...makeValid(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden for Fundamental Agent');
  });

  test('dataPoints 含 news category 被 reject（§0 隔離）', () => {
    const dps = makeDataPoints();
    (dps[4] as { category: string }).category = 'news';
    const r = validate({ ...makeValid(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden for Fundamental Agent');
  });

  test('fundamental 不足 6 筆被 reject', () => {
    const r = validate({ ...makeValid(), dataPoints: makeDataPoints(3, 2, 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('fundamental dataPoints too few');
  });

  test('valuation 不足 2 筆被 reject', () => {
    const r = validate({ ...makeValid(), dataPoints: makeDataPoints(6, 1, 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('valuation dataPoints too few');
  });
});
