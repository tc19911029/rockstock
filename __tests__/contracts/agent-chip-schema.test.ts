/**
 * Contract test：Chip Agent answer schema
 *
 * 守的規則（§0 隔離）：
 *   - schemaVersion = 1，agent = 'chip'
 *   - reasoning 4 段（institutional / margin / lending / large_holders）
 *   - dataPoints ≥ 8 筆，全部 category='chip'（**禁止 technical/news/fundamental**）
 */

import {
  AGENT_SCHEMA_VERSION,
  ChipAnswer,
  CHIP_REQUIRED_SECTIONS,
  ChipReasoningItem,
  ChipSection,
  DataPoint,
} from '@/lib/agents/types';

const MIN_DATAPOINTS = 8;
const FORBIDDEN: ReadonlyArray<string> = [
  'technical', 'news', 'fundamental', 'valuation', 'macro', 'governance', 'industry',
];

function validate(d: unknown): { ok: true } | { ok: false; reason: string } {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not an object' };
  const v = d as Record<string, unknown>;

  if (v.schemaVersion !== AGENT_SCHEMA_VERSION) return { ok: false, reason: `schemaVersion ≠ 1` };
  if (v.agent !== 'chip') return { ok: false, reason: `agent ≠ 'chip'` };
  if (v.verdict !== 'pass' && v.verdict !== 'watch' && v.verdict !== 'fail') {
    return { ok: false, reason: `verdict invalid: ${v.verdict}` };
  }
  if (typeof v.overview !== 'string' || !v.overview) return { ok: false, reason: 'overview missing' };
  if (typeof v.verdictReason !== 'string' || !v.verdictReason) {
    return { ok: false, reason: 'verdictReason missing' };
  }

  if (!Array.isArray(v.reasoning)) return { ok: false, reason: 'reasoning not array' };
  const sections = new Set((v.reasoning as ChipReasoningItem[]).map((r) => r.section));
  for (const req of CHIP_REQUIRED_SECTIONS) {
    if (!sections.has(req)) return { ok: false, reason: `missing reasoning section: ${req}` };
  }
  for (const item of v.reasoning as ChipReasoningItem[]) {
    if (typeof item.text !== 'string' || !item.text) {
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
    if (FORBIDDEN.includes(p.category)) {
      return { ok: false, reason: `dataPoints[${i}] category '${p.category}' forbidden for Chip Agent (violates §0 isolation)` };
    }
    if (p.category !== 'chip') return { ok: false, reason: `dataPoints[${i}].category must be 'chip' (got ${p.category})` };
    if (typeof p.label !== 'string' || !p.label) return { ok: false, reason: `dataPoints[${i}].label missing` };
    if (typeof p.value !== 'string' || !p.value) return { ok: false, reason: `dataPoints[${i}].value missing` };
    if (typeof p.source !== 'string' || !p.source) return { ok: false, reason: `dataPoints[${i}].source missing` };
  }

  return { ok: true };
}

function makeReasoning(): ChipReasoningItem[] {
  const sources: Record<ChipSection, string[]> = {
    institutional: ['prefetch.chip.foreignBuy', 'prefetch.chip.trustBuy'],
    margin:        ['prefetch.chip.marginBalance'],
    lending:       ['prefetch.chip.lendingBalance'],
    large_holders: ['prefetch.chip.largeHolderPct'],
  };
  return CHIP_REQUIRED_SECTIONS.map((s) => ({
    section: s,
    text: `${s} 段：依 prefetch.chip 資料判斷（範例文字 ≥ 30 字之佔位）`,
    sources: sources[s],
  }));
}

function makeDataPoints(n = MIN_DATAPOINTS): DataPoint[] {
  const labels = ['chipScore', 'chipSignal', 'foreignBuy', 'trustBuy', 'marginBalance', 'dayTradeRatio', 'largeHolderPct', 'lendingBalance', 'dealerBuy', 'shortBalance'];
  return Array.from({ length: n }, (_, i) => ({
    category: 'chip' as const,
    label: labels[i] ?? `chip-${i}`,
    value: `${i}`,
    source: `prefetch.chip.${labels[i] ?? 'field'}`,
    asOf: '2026-05-22',
  }));
}

function makeValid(overrides: Partial<ChipAnswer> = {}): ChipAnswer {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'chip',
    runId: 'rid-1',
    date: '2026-05-22',
    symbol: '2330.TW',
    verdict: 'watch',
    overview: 'chipScore=51，外資買超 4,251 張',
    verdictReason: 'chipScore 中性區間，融資未過熱',
    reasoning: makeReasoning(),
    dataPoints: makeDataPoints(),
    ...overrides,
  };
}

describe('Chip Agent answer schema', () => {
  test('合法 answer 通過驗證', () => {
    expect(validate(makeValid())).toEqual({ ok: true });
  });

  test('reasoning 漏掉 lending 被 reject', () => {
    const partial = makeReasoning().filter((r) => r.section !== 'lending');
    const r = validate({ ...makeValid(), reasoning: partial });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('lending');
  });

  test('dataPoints 含 technical category 被 reject（§0 隔離）', () => {
    const dps = makeDataPoints();
    (dps[1] as { category: string }).category = 'technical';
    const r = validate({ ...makeValid(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden for Chip Agent');
  });

  test('dataPoints 含 fundamental category 被 reject（§0 隔離）', () => {
    const dps = makeDataPoints();
    (dps[3] as { category: string }).category = 'fundamental';
    const r = validate({ ...makeValid(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden for Chip Agent');
  });

  test('dataPoints 含 news category 被 reject（§0 隔離）', () => {
    const dps = makeDataPoints();
    (dps[0] as { category: string }).category = 'news';
    const r = validate({ ...makeValid(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden for Chip Agent');
  });

  test('dataPoints 不足 8 筆被 reject', () => {
    const r = validate({ ...makeValid(), dataPoints: makeDataPoints(5) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('dataPoints too few');
  });

  test('agent ≠ chip 被 reject', () => {
    const r = validate({ ...makeValid(), agent: 'technical' });
    expect(r.ok).toBe(false);
  });
});
