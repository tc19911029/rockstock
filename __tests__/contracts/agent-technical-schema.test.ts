/**
 * Contract test：Technical Agent answer schema
 *
 * 守的規則（P1 紅線）：
 *   - schemaVersion = 1，agent = 'technical'
 *   - verdict ∈ {pass, watch, fail}
 *   - reasoning 6 段（trend/kbar/ma/volume/kd/mtf）全部齊
 *   - 每段 reasoning.text 非空、ruleIds 非空陣列
 *   - dataPoints ≥ 8 筆，且全部 category='technical'
 *   - bookCitations ≥ 10 條，且 ruleId ∈ KNOWN_BOOK_RULE_IDS（c-/p-/e-/m- 開頭）
 *   - 六條件 6 條（c-trend ~ c-indicator）必須全在 bookCitations 出現
 *   - 隔離：dataPoints 不可含 chip / fundamental / news / macro / valuation /
 *           governance / industry category（這些屬於其他 Agent，違反 §0 隔離原則）
 *
 * 這是 LLM 輸出守門員：/multi-agent-decide skill 若違反任一條，UI polling reject。
 */

import {
  AGENT_SCHEMA_VERSION,
  BookCitation,
  DataPoint,
  ELIMINATION_RULE_IDS,
  KNOWN_BOOK_RULE_IDS,
  LONG_PROHIBITION_RULE_IDS,
  MTF_WEEKLY_RULE_IDS,
  SIX_CONDITION_RULE_IDS,
  TECHNICAL_REQUIRED_SECTIONS,
  TechnicalAnswer,
  TechnicalReasoningItem,
  TechnicalSection,
} from '@/lib/agents/types';

const MIN_DATAPOINTS = 8;
const MIN_BOOK_CITATIONS = 10;

const FORBIDDEN_CATEGORIES_FOR_TECHNICAL: ReadonlyArray<string> = [
  'chip', 'fundamental', 'news', 'macro', 'valuation', 'governance', 'industry',
];

function validateTechnicalAnswer(d: unknown): { ok: true } | { ok: false; reason: string } {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not an object' };
  const v = d as Record<string, unknown>;

  if (v.schemaVersion !== AGENT_SCHEMA_VERSION) {
    return { ok: false, reason: `schemaVersion ≠ ${AGENT_SCHEMA_VERSION} (got ${v.schemaVersion})` };
  }
  if (v.agent !== 'technical') {
    return { ok: false, reason: `agent ≠ 'technical' (got ${v.agent})` };
  }
  if (typeof v.runId !== 'string' || !v.runId) return { ok: false, reason: 'runId missing' };
  if (typeof v.date !== 'string' || !v.date) return { ok: false, reason: 'date missing' };
  if (typeof v.symbol !== 'string' || !v.symbol) return { ok: false, reason: 'symbol missing' };

  if (v.verdict !== 'pass' && v.verdict !== 'watch' && v.verdict !== 'fail') {
    return { ok: false, reason: `verdict invalid: ${v.verdict}` };
  }
  if (typeof v.overview !== 'string' || !v.overview) return { ok: false, reason: 'overview missing' };
  if (typeof v.verdictReason !== 'string' || !v.verdictReason) {
    return { ok: false, reason: 'verdictReason missing' };
  }

  // ── reasoning ──
  if (!Array.isArray(v.reasoning)) return { ok: false, reason: 'reasoning not array' };
  const reasoning = v.reasoning as TechnicalReasoningItem[];
  const sections = new Set(reasoning.map((r) => r.section));
  for (const required of TECHNICAL_REQUIRED_SECTIONS) {
    if (!sections.has(required)) {
      return { ok: false, reason: `missing reasoning section: ${required}` };
    }
  }
  for (const item of reasoning) {
    if (typeof item.text !== 'string' || item.text.length === 0) {
      return { ok: false, reason: `reasoning.${item.section} text missing` };
    }
    if (!Array.isArray(item.ruleIds) || item.ruleIds.length === 0) {
      return { ok: false, reason: `reasoning.${item.section} ruleIds missing` };
    }
    for (const rid of item.ruleIds) {
      if (!KNOWN_BOOK_RULE_IDS.has(rid)) {
        return { ok: false, reason: `reasoning.${item.section} unknown ruleId: ${rid}` };
      }
    }
  }

  // ── dataPoints ──
  if (!Array.isArray(v.dataPoints)) return { ok: false, reason: 'dataPoints not array' };
  const dps = v.dataPoints as DataPoint[];
  if (dps.length < MIN_DATAPOINTS) {
    return { ok: false, reason: `dataPoints too few: ${dps.length} < ${MIN_DATAPOINTS}` };
  }
  for (let i = 0; i < dps.length; i++) {
    const p = dps[i];
    if (!p || typeof p !== 'object') return { ok: false, reason: `dataPoints[${i}] not object` };
    if (typeof p.category !== 'string') return { ok: false, reason: `dataPoints[${i}].category missing` };
    // §0 Agent 隔離原則：Technical Agent 不可寫其他面向的 dataPoint
    if (FORBIDDEN_CATEGORIES_FOR_TECHNICAL.includes(p.category)) {
      return {
        ok: false,
        reason:
          `dataPoints[${i}] category '${p.category}' forbidden for Technical Agent ` +
          `(violates §0 isolation principle — those belong to other agents)`,
      };
    }
    if (p.category !== 'technical') {
      return { ok: false, reason: `dataPoints[${i}].category must be 'technical' (got ${p.category})` };
    }
    if (typeof p.label !== 'string' || !p.label) return { ok: false, reason: `dataPoints[${i}].label missing` };
    if (typeof p.value !== 'string' || !p.value) return { ok: false, reason: `dataPoints[${i}].value missing` };
    if (typeof p.source !== 'string' || !p.source) return { ok: false, reason: `dataPoints[${i}].source missing` };
  }

  // ── bookCitations ──
  if (!Array.isArray(v.bookCitations)) return { ok: false, reason: 'bookCitations not array' };
  const cites = v.bookCitations as BookCitation[];
  if (cites.length < MIN_BOOK_CITATIONS) {
    return { ok: false, reason: `bookCitations too few: ${cites.length} < ${MIN_BOOK_CITATIONS}` };
  }
  for (let i = 0; i < cites.length; i++) {
    const c = cites[i];
    if (!c || typeof c !== 'object') return { ok: false, reason: `bookCitations[${i}] not object` };
    if (typeof c.ruleId !== 'string') return { ok: false, reason: `bookCitations[${i}].ruleId missing` };
    if (!KNOWN_BOOK_RULE_IDS.has(c.ruleId)) {
      return { ok: false, reason: `bookCitations[${i}] unknown ruleId: ${c.ruleId}` };
    }
    if (typeof c.label !== 'string' || !c.label) return { ok: false, reason: `bookCitations[${i}].label missing` };
    if (typeof c.value !== 'string') return { ok: false, reason: `bookCitations[${i}].value missing` };
    if (typeof c.pass !== 'boolean') return { ok: false, reason: `bookCitations[${i}].pass not boolean` };
  }

  // 六條件 6 條必須全在 bookCitations 出現
  const citedIds = new Set(cites.map((c) => c.ruleId));
  for (const sixId of SIX_CONDITION_RULE_IDS) {
    if (!citedIds.has(sixId)) {
      return { ok: false, reason: `bookCitations missing six-condition: ${sixId}` };
    }
  }

  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ────────────────────────────────────────────────────────────────────────────

function makeReasoning(): TechnicalReasoningItem[] {
  const ruleMap: Record<TechnicalSection, string[]> = {
    trend:  ['c-trend', 'e-01'],
    kbar:   ['c-kbar'],
    ma:     ['c-ma', 'c-position'],
    volume: ['c-volume'],
    kd:     ['c-indicator'],
    mtf:    ['m-trend', 'm-ma', 'm-position'],
  };
  return TECHNICAL_REQUIRED_SECTIONS.map((s) => ({
    section: s,
    text: `${s} 段：依書本規則判斷，引用 candidateRow 欄位（範例文字 ≥ 30 字之佔位）`,
    ruleIds: ruleMap[s],
  }));
}

function makeDataPoints(n = MIN_DATAPOINTS): DataPoint[] {
  const labels = ['price', 'changePct', 'volume', 'sixScore', 'trend', 'pos', 'matched', 'mtfPass', 'ma20Slope', 'highWinRateScore'];
  return Array.from({ length: n }, (_, i) => ({
    category: 'technical' as const,
    label: labels[i] ?? `dp-${i}`,
    value: `${i}`,
    source: `L4.candidateRow.${labels[i] ?? 'field'}`,
    asOf: '2026-05-22',
  }));
}

function makeBookCitations(): BookCitation[] {
  const sixConditions: BookCitation[] = SIX_CONDITION_RULE_IDS.map((id) => ({
    ruleId: id,
    label: id,
    value: 'true',
    pass: true,
  }));
  const extras: BookCitation[] = [
    { ruleId: 'p-02', label: '戒律 2', value: 'not_triggered', pass: true },
    { ruleId: 'p-08', label: '戒律 8', value: 'not_triggered', pass: true },
    { ruleId: 'e-04', label: '淘汰 R4', value: 'not_triggered', pass: true },
    { ruleId: 'e-07', label: '淘汰 R7', value: 'not_triggered', pass: true },
  ];
  return [...sixConditions, ...extras];
}

function makeValidAnswer(overrides: Partial<TechnicalAnswer> = {}): TechnicalAnswer {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'technical',
    runId: '2026-05-22-2330-20260522101500',
    date: '2026-05-22',
    symbol: '2330',
    verdict: 'pass',
    overview: '日線多頭，六條件全過，週線同步多頭',
    verdictReason: '技術面 5/6 + 戒律全不觸 + 淘汰法不觸',
    reasoning: makeReasoning(),
    dataPoints: makeDataPoints(),
    bookCitations: makeBookCitations(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('Technical Agent answer schema', () => {
  test('合法 answer 通過驗證', () => {
    expect(validateTechnicalAnswer(makeValidAnswer())).toEqual({ ok: true });
  });

  test('schemaVersion ≠ 1 被 reject', () => {
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), schemaVersion: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('schemaVersion');
  });

  test('agent ≠ technical 被 reject', () => {
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), agent: 'chip' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("agent");
  });

  test('verdict 非合法值被 reject', () => {
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), verdict: 'BUY' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('verdict invalid');
  });

  test('reasoning 漏掉某段被 reject (mtf)', () => {
    const partial = makeReasoning().filter((r) => r.section !== 'mtf');
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), reasoning: partial });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('mtf');
  });

  test('reasoning.text 為空被 reject', () => {
    const items = makeReasoning();
    items[2].text = '';
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), reasoning: items });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('text missing');
  });

  test('reasoning.ruleIds 為空被 reject', () => {
    const items = makeReasoning();
    items[0].ruleIds = [];
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), reasoning: items });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('ruleIds missing');
  });

  test('reasoning.ruleIds 含自創 ruleId 被 reject', () => {
    const items = makeReasoning();
    items[0].ruleIds = ['c-trend', '黃金交叉'];  // 「黃金交叉」非書本規則
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), reasoning: items });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('unknown ruleId');
  });

  test('dataPoints 不足 8 筆被 reject', () => {
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), dataPoints: makeDataPoints(5) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('dataPoints too few');
  });

  test('dataPoints 含 chip category 被 reject（§0 隔離原則）', () => {
    const dps = makeDataPoints();
    (dps[2] as { category: string }).category = 'chip';
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden for Technical Agent');
  });

  test('dataPoints 含 fundamental category 被 reject（§0 隔離原則）', () => {
    const dps = makeDataPoints();
    (dps[1] as { category: string }).category = 'fundamental';
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden for Technical Agent');
  });

  test('dataPoints 含 news category 被 reject（§0 隔離原則）', () => {
    const dps = makeDataPoints();
    (dps[3] as { category: string }).category = 'news';
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('forbidden for Technical Agent');
  });

  test('dataPoints 缺 source 被 reject', () => {
    const dps = makeDataPoints();
    dps[0].source = '';
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), dataPoints: dps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('source missing');
  });

  test('bookCitations 不足 10 條被 reject', () => {
    const cites = makeBookCitations().slice(0, 8);
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), bookCitations: cites });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('bookCitations too few');
  });

  test('bookCitations 含自創 ruleId 被 reject', () => {
    const cites = makeBookCitations();
    (cites[0] as { ruleId: string }).ruleId = 'kd-golden-cross';
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), bookCitations: cites });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('unknown ruleId');
  });

  test('bookCitations 漏掉某個六條件被 reject', () => {
    const cites = makeBookCitations().filter((c) => c.ruleId !== 'c-volume');
    // 補足數量到 10
    cites.push({ ruleId: 'p-05', label: '戒律 5', value: 'not_triggered', pass: true });
    const r = validateTechnicalAnswer({ ...makeValidAnswer(), bookCitations: cites });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('c-volume');
  });

  test('六條件 6 條全在白名單', () => {
    for (const id of SIX_CONDITION_RULE_IDS) {
      expect(KNOWN_BOOK_RULE_IDS.has(id)).toBe(true);
    }
  });

  test('戒律 10 條全在白名單', () => {
    for (const id of LONG_PROHIBITION_RULE_IDS) {
      expect(KNOWN_BOOK_RULE_IDS.has(id)).toBe(true);
    }
  });

  test('淘汰法 11 條全在白名單', () => {
    for (const id of ELIMINATION_RULE_IDS) {
      expect(KNOWN_BOOK_RULE_IDS.has(id)).toBe(true);
    }
  });

  test('MTF 週線 6 條全在白名單', () => {
    for (const id of MTF_WEEKLY_RULE_IDS) {
      expect(KNOWN_BOOK_RULE_IDS.has(id)).toBe(true);
    }
  });
});
