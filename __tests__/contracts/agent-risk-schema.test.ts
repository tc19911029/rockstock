/**
 * Contract test：Risk Agent answer schema
 *
 * 守的規則：
 *   - schemaVersion = 1, agent = 'risk'
 *   - verdict ∈ {green, yellow, red}（不允許 pass/watch/fail — 風控不負責通過）
 *   - hardBlockers 非空 → verdict 必須是 'red'（§0 — 風控否決權）
 *   - hardBlockers 為空 + softWarnings 非空 → verdict 應為 'yellow'
 *   - hardBlockers 與 softWarnings 都空 → verdict 應為 'green'
 */

import { AGENT_SCHEMA_VERSION, RiskAnswer } from '@/lib/agents/types';

function validate(d: unknown): { ok: true } | { ok: false; reason: string } {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not an object' };
  const v = d as Record<string, unknown>;

  if (v.schemaVersion !== AGENT_SCHEMA_VERSION) return { ok: false, reason: `schemaVersion ≠ 1` };
  if (v.agent !== 'risk') return { ok: false, reason: `agent ≠ 'risk'` };
  if (v.verdict !== 'green' && v.verdict !== 'yellow' && v.verdict !== 'red') {
    return { ok: false, reason: `verdict invalid: ${v.verdict} (must be green/yellow/red)` };
  }
  if (typeof v.overview !== 'string' || !v.overview) return { ok: false, reason: 'overview missing' };
  if (typeof v.verdictReason !== 'string' || !v.verdictReason) {
    return { ok: false, reason: 'verdictReason missing' };
  }

  if (!Array.isArray(v.hardBlockers)) return { ok: false, reason: 'hardBlockers not array' };
  if (!Array.isArray(v.softWarnings)) return { ok: false, reason: 'softWarnings not array' };
  if (!Array.isArray(v.events)) return { ok: false, reason: 'events not array' };

  const blockers = v.hardBlockers as Array<{ label?: string; severity?: string }>;
  // §0 核心紅線：hardBlocker 觸發 → 必須 red
  if (blockers.length > 0 && v.verdict !== 'red') {
    return {
      ok: false,
      reason: `verdict must be 'red' when hardBlockers non-empty (got '${v.verdict}'); 違反 §0 風控否決權`,
    };
  }

  // 反向：hardBlocker 空 + softWarning 非空 → 應為 yellow
  const warnings = v.softWarnings as unknown[];
  if (blockers.length === 0 && warnings.length > 0 && v.verdict !== 'yellow') {
    return { ok: false, reason: `verdict should be 'yellow' when only softWarnings present (got '${v.verdict}')` };
  }

  // 反向：都空 → green
  if (blockers.length === 0 && warnings.length === 0 && v.verdict !== 'green') {
    return { ok: false, reason: `verdict should be 'green' when no blockers/warnings (got '${v.verdict}')` };
  }

  for (let i = 0; i < blockers.length; i++) {
    const b = blockers[i];
    if (typeof b.label !== 'string' || !b.label) {
      return { ok: false, reason: `hardBlockers[${i}].label missing` };
    }
    if (b.severity !== 'critical' && b.severity !== 'high') {
      return { ok: false, reason: `hardBlockers[${i}].severity invalid` };
    }
  }

  return { ok: true };
}

function makeValid(overrides: Partial<RiskAnswer> = {}): RiskAnswer {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'risk',
    runId: 'rid-1',
    date: '2026-05-22',
    symbol: '2330.TW',
    verdict: 'green',
    overview: '無觸發任何戒律與淘汰法',
    verdictReason: '六條件全過 + 戒律不觸 + 無事件風險',
    hardBlockers: [],
    softWarnings: [],
    events: [],
    ...overrides,
  };
}

describe('Risk Agent answer schema', () => {
  test('合法 green answer（全空）通過', () => {
    expect(validate(makeValid())).toEqual({ ok: true });
  });

  test('hardBlocker 觸發 + verdict=red 通過', () => {
    const r = validate(makeValid({
      verdict: 'red',
      overview: '觸發淘汰 R7',
      verdictReason: '頭頭低 + MACD 背離',
      hardBlockers: [{ ruleId: 'e-07', label: '淘汰 R7：頭頭低', severity: 'critical' }],
    }));
    expect(r).toEqual({ ok: true });
  });

  test('§0 紅線：hardBlocker 觸發但 verdict=yellow 被 reject', () => {
    const r = validate(makeValid({
      verdict: 'yellow',
      hardBlockers: [{ ruleId: 'e-07', label: '淘汰 R7', severity: 'critical' }],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('verdict must be');
  });

  test('§0 紅線：hardBlocker 觸發但 verdict=green 被 reject', () => {
    const r = validate(makeValid({
      verdict: 'green',
      hardBlockers: [{ label: '戒律 8', severity: 'high' }],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('verdict must be');
  });

  test('verdict ∈ pass/watch/fail 被 reject（風控 schema 是 green/yellow/red）', () => {
    const r = validate(makeValid({ verdict: 'pass' as unknown as RiskAnswer['verdict'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('verdict invalid');
  });

  test('softWarning 非空 + hardBlocker 空 → verdict=yellow 通過', () => {
    const r = validate(makeValid({
      verdict: 'yellow',
      overview: '位置 96%',
      verdictReason: '接近壓力',
      softWarnings: [{ label: '位置 96%', impact: 'high' }],
    }));
    expect(r).toEqual({ ok: true });
  });

  test('softWarning 非空但 verdict=green 被 reject', () => {
    const r = validate(makeValid({
      verdict: 'green',
      softWarnings: [{ label: '位置 96%', impact: 'high' }],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('yellow');
  });

  test('hardBlockers[i].severity 必須 critical/high', () => {
    const r = validate(makeValid({
      verdict: 'red',
      hardBlockers: [{ label: 'x', severity: 'low' as 'critical' | 'high' }],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('severity invalid');
  });

  test('hardBlockers / softWarnings / events 必為 array', () => {
    const r = validate(makeValid({
      hardBlockers: 'not-array' as unknown as RiskAnswer['hardBlockers'],
    }));
    expect(r.ok).toBe(false);
  });
});
