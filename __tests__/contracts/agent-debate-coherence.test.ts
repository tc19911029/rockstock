/**
 * Contract test：Bull / Bear 辯論一致性
 *
 * 守的規則（§0 — Bull/Bear 是辯護角色，不是新規則來源）：
 *   - Bull evidence 必須能解析回 A-E answer 的 dataPoint
 *   - Bear rebuttals.length === bullThesis.length（一對一反駁）
 *   - rebuts index 必須在 bullThesis 範圍內
 *   - bullThesis ≥ 3 條
 *   - weaknessAcknowledged 不可空（強制誠實）
 */

import { AGENT_SCHEMA_VERSION, BearThesis, BullThesis, EvidenceRef } from '@/lib/agents/types';

interface ResolveTarget {
  technical?: { dataPoints: Array<{ label: string }> };
  news?:      { dataPoints: Array<{ label: string }> };
  chip?:      { dataPoints: Array<{ label: string }> };
  fundamental?: { dataPoints: Array<{ label: string }> };
  risk?:      Record<string, unknown>;  // risk 沒 dataPoints
}

/** evidence 必須能在對應 agent answer 的 dataPoints 內找到 */
function evidenceResolves(ref: EvidenceRef, t: ResolveTarget): boolean {
  if (ref.agent === 'risk') return true;  // risk 無 dataPoint，但 evidence 可指 risk 整體
  const ag = t[ref.agent as 'technical' | 'news' | 'chip' | 'fundamental'];
  if (!ag) return false;
  return ref.dataPointIndex >= 0 && ref.dataPointIndex < ag.dataPoints.length;
}

function validateBull(b: unknown, target: ResolveTarget): { ok: true } | { ok: false; reason: string } {
  if (!b || typeof b !== 'object') return { ok: false, reason: 'not an object' };
  const v = b as Record<string, unknown>;
  if (v.schemaVersion !== AGENT_SCHEMA_VERSION) return { ok: false, reason: 'schemaVersion ≠ 1' };
  if (v.agent !== 'bull') return { ok: false, reason: `agent ≠ 'bull'` };
  if (!Array.isArray(v.bullThesis)) return { ok: false, reason: 'bullThesis not array' };
  if (v.bullThesis.length < 3) return { ok: false, reason: `bullThesis too few: ${v.bullThesis.length} < 3` };

  const claims = v.bullThesis as BullThesis['bullThesis'];
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i];
    if (typeof c.claim !== 'string' || !c.claim) return { ok: false, reason: `bullThesis[${i}].claim missing` };
    if (!Array.isArray(c.evidence) || c.evidence.length === 0) {
      return { ok: false, reason: `bullThesis[${i}].evidence empty (§0 — 不可自創事實)` };
    }
    if (typeof c.weaknessAcknowledged !== 'string' || !c.weaknessAcknowledged) {
      return { ok: false, reason: `bullThesis[${i}].weaknessAcknowledged missing (§0 — 強制誠實)` };
    }
    if (c.strength < 1 || c.strength > 5) {
      return { ok: false, reason: `bullThesis[${i}].strength out of range` };
    }
    for (let j = 0; j < c.evidence.length; j++) {
      if (!evidenceResolves(c.evidence[j], target)) {
        return {
          ok: false,
          reason: `bullThesis[${i}].evidence[${j}] cannot resolve to ${c.evidence[j].agent}.dp[${c.evidence[j].dataPointIndex}] (§0 — 引用無效)`,
        };
      }
    }
  }
  return { ok: true };
}

function validateBear(
  b: unknown,
  bull: BullThesis,
  target: ResolveTarget,
): { ok: true } | { ok: false; reason: string } {
  if (!b || typeof b !== 'object') return { ok: false, reason: 'not an object' };
  const v = b as Record<string, unknown>;
  if (v.schemaVersion !== AGENT_SCHEMA_VERSION) return { ok: false, reason: 'schemaVersion ≠ 1' };
  if (v.agent !== 'bear') return { ok: false, reason: `agent ≠ 'bear'` };
  if (!Array.isArray(v.rebuttals)) return { ok: false, reason: 'rebuttals not array' };

  const rebuttals = v.rebuttals as BearThesis['rebuttals'];
  // §0：rebuttals.length 必須等於 bullThesis.length（一對一反駁）
  if (rebuttals.length !== bull.bullThesis.length) {
    return {
      ok: false,
      reason: `rebuttals.length (${rebuttals.length}) ≠ bullThesis.length (${bull.bullThesis.length}) — 違反一對一反駁`,
    };
  }

  for (let i = 0; i < rebuttals.length; i++) {
    const r = rebuttals[i];
    if (typeof r.rebuts !== 'number' || r.rebuts < 0 || r.rebuts >= bull.bullThesis.length) {
      return { ok: false, reason: `rebuttals[${i}].rebuts index out of range` };
    }
    if (typeof r.counter !== 'string' || !r.counter) return { ok: false, reason: `rebuttals[${i}].counter missing` };
    if (!Array.isArray(r.evidence)) return { ok: false, reason: `rebuttals[${i}].evidence not array` };
    for (let j = 0; j < r.evidence.length; j++) {
      if (!evidenceResolves(r.evidence[j], target)) {
        return { ok: false, reason: `rebuttals[${i}].evidence[${j}] cannot resolve` };
      }
    }
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────────────

const sampleTarget: ResolveTarget = {
  technical:   { dataPoints: [{label:'a'},{label:'b'},{label:'c'},{label:'d'},{label:'e'}] },
  news:        { dataPoints: [{label:'n1'},{label:'n2'}] },
  chip:        { dataPoints: [{label:'c1'},{label:'c2'}] },
  fundamental: { dataPoints: [{label:'f1'}] },
};

const sampleBull: BullThesis = {
  schemaVersion: AGENT_SCHEMA_VERSION, agent: 'bull', runId: 'r', date: '2026-05-22', symbol: '2330.TW',
  overview: '多方總結',
  totalStrength: 12,
  bullThesis: [
    { claim: '六條件 6/6', evidence: [{ agent: 'technical', dataPointIndex: 3, label: 'sixScore' }], strength: 4, weaknessAcknowledged: '週線未過' },
    { claim: 'YouTube 高共識', evidence: [{ agent: 'news', dataPointIndex: 0, label: 'mention' }], strength: 4, weaknessAcknowledged: 'sample size 小' },
    { claim: '法人連買', evidence: [{ agent: 'chip', dataPointIndex: 1, label: 'foreign' }], strength: 4, weaknessAcknowledged: '融資略偏高' },
  ],
};

const sampleBear: BearThesis = {
  schemaVersion: AGENT_SCHEMA_VERSION, agent: 'bear', runId: 'r', date: '2026-05-22', symbol: '2330.TW',
  overview: '空方總結',
  totalStrength: 9,
  additionalConcerns: [],
  rebuttals: [
    { rebuts: 0, counter: '週線盤整', evidence: [{ agent: 'technical', dataPointIndex: 4, label: 'mtfFail' }], strength: 3 },
    { rebuts: 1, counter: '節目樣本小', evidence: [], strength: 3, partialValidity: '確實有共識' },
    { rebuts: 2, counter: '融資過熱', evidence: [{ agent: 'chip', dataPointIndex: 0, label: 'margin' }], strength: 3 },
  ],
};

describe('Bull Researcher schema', () => {
  test('合法 bull 通過', () => {
    expect(validateBull(sampleBull, sampleTarget)).toEqual({ ok: true });
  });

  test('bullThesis < 3 被 reject', () => {
    const r = validateBull({ ...sampleBull, bullThesis: sampleBull.bullThesis.slice(0, 2) }, sampleTarget);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('too few');
  });

  test('evidence 為空被 reject（§0 不可自創事實）', () => {
    const bullEmpty = {
      ...sampleBull,
      bullThesis: [{ ...sampleBull.bullThesis[0], evidence: [] }, sampleBull.bullThesis[1], sampleBull.bullThesis[2]],
    };
    const r = validateBull(bullEmpty, sampleTarget);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('evidence empty');
  });

  test('evidence 引用無效 dataPointIndex 被 reject', () => {
    const bad = {
      ...sampleBull,
      bullThesis: [
        { ...sampleBull.bullThesis[0], evidence: [{ agent: 'technical' as const, dataPointIndex: 999, label: 'x' }] },
        sampleBull.bullThesis[1], sampleBull.bullThesis[2],
      ],
    };
    const r = validateBull(bad, sampleTarget);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('cannot resolve');
  });

  test('weaknessAcknowledged 空被 reject（§0 強制誠實）', () => {
    const bad = {
      ...sampleBull,
      bullThesis: [{ ...sampleBull.bullThesis[0], weaknessAcknowledged: '' }, sampleBull.bullThesis[1], sampleBull.bullThesis[2]],
    };
    const r = validateBull(bad, sampleTarget);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('weaknessAcknowledged');
  });
});

describe('Bear Researcher schema (一對一反駁)', () => {
  test('合法 bear 通過', () => {
    expect(validateBear(sampleBear, sampleBull, sampleTarget)).toEqual({ ok: true });
  });

  test('rebuttals.length ≠ bullThesis.length 被 reject', () => {
    const r = validateBear({ ...sampleBear, rebuttals: sampleBear.rebuttals.slice(0, 2) }, sampleBull, sampleTarget);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('一對一反駁');
  });

  test('rebuts index 超出範圍被 reject', () => {
    const r = validateBear({
      ...sampleBear,
      rebuttals: [...sampleBear.rebuttals.slice(0, 2), { ...sampleBear.rebuttals[2], rebuts: 99 }],
    }, sampleBull, sampleTarget);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('out of range');
  });

  test('rebuttal evidence 解析無效被 reject', () => {
    const bad = {
      ...sampleBear,
      rebuttals: [
        { rebuts: 0, counter: 'x', evidence: [{ agent: 'chip' as const, dataPointIndex: 999, label: 'x' }], strength: 3 as const },
        ...sampleBear.rebuttals.slice(1),
      ],
    };
    const r = validateBear(bad, sampleBull, sampleTarget);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('cannot resolve');
  });

  test('rebuttal.evidence 空陣列 OK（代表論點本身就薄弱）', () => {
    const r = validateBear({
      ...sampleBear,
      rebuttals: [
        { rebuts: 0, counter: '論點薄弱', evidence: [], strength: 2 as const, partialValidity: '部分對' },
        ...sampleBear.rebuttals.slice(1),
      ],
    }, sampleBull, sampleTarget);
    expect(r).toEqual({ ok: true });
  });
});
