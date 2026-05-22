/**
 * Contract test：Decision Agent 規則式整合表
 *
 * §0 紅線：
 *   - Technical='fail' → action='skip'（無條件最高優先）
 *   - Technical='pass' + Risk='red' → action='skip'
 *   - Technical='pass' + Risk='green' + (bull - bear ≥ 2) → action='buy'
 *   - 不允許「總分」「綜合評等」（schema 沒有 compositeScore）
 *   - decisionPath 必須對應實際 verdicts
 */

import { AGENT_SCHEMA_VERSION, FinalDecision } from '@/lib/agents/types';

function validate(d: unknown): { ok: true } | { ok: false; reason: string } {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not an object' };
  const v = d as Record<string, unknown>;

  if (v.schemaVersion !== AGENT_SCHEMA_VERSION) return { ok: false, reason: 'schemaVersion ≠ 1' };
  if (v.agent !== 'decision') return { ok: false, reason: `agent ≠ 'decision'` };
  if (v.action !== 'buy' && v.action !== 'watch' && v.action !== 'skip') {
    return { ok: false, reason: `action invalid: ${v.action}` };
  }
  if (typeof v.decisionPath !== 'string') return { ok: false, reason: 'decisionPath missing' };

  // §0：不允許 compositeScore（避免「加權平均」概念）
  if ('compositeScore' in v) {
    return { ok: false, reason: `compositeScore forbidden — §0 不允許加權平均/總分概念` };
  }

  // verdictsByAgent 5 個面向都要有 key
  const v_ = v.verdictsByAgent as Record<string, string | null> | undefined;
  if (!v_) return { ok: false, reason: 'verdictsByAgent missing' };
  for (const k of ['technical', 'news', 'chip', 'fundamental', 'risk']) {
    if (!(k in v_)) return { ok: false, reason: `verdictsByAgent.${k} missing` };
  }

  // bullScore / bearScore 必填
  if (typeof v.bullScore !== 'number') return { ok: false, reason: 'bullScore not number' };
  if (typeof v.bearScore !== 'number') return { ok: false, reason: 'bearScore not number' };
  if (typeof v.sizeHint !== 'number') return { ok: false, reason: 'sizeHint not number' };
  if (v.sizeHint < 0 || v.sizeHint > 1) return { ok: false, reason: 'sizeHint out of [0,1]' };

  // conflicts 必為 array（可空，但不可缺）
  if (!Array.isArray(v.conflicts)) return { ok: false, reason: 'conflicts not array' };

  // ── 規則式決策表強制檢查（§0 紅線）──
  const t = v_.technical;
  const risk = v_.risk;
  const bull = v.bullScore as number;
  const bear = v.bearScore as number;
  const action = v.action as FinalDecision['action'];
  const path = v.decisionPath as string;

  // 規則 1：Technical fail → action='skip'
  if (t === 'fail' && action !== 'skip') {
    return { ok: false, reason: `Technical='fail' 必須 action='skip'（§0 風控優先）, got '${action}'` };
  }
  if (t === 'fail' && path !== 'technical_fail') {
    return { ok: false, reason: `Technical='fail' decisionPath 必須是 'technical_fail', got '${path}'` };
  }

  // 規則 2：Technical pass + Risk red → skip
  if (t === 'pass' && risk === 'red' && action !== 'skip') {
    return { ok: false, reason: `Risk='red' 必須 action='skip'（§0 風控否決權）, got '${action}'` };
  }

  // 規則 3：Technical pass + Risk green + (bull - bear ≥ 2) → buy
  if (t === 'pass' && risk === 'green' && bull - bear >= 2 && action !== 'buy') {
    return {
      ok: false,
      reason: `T=pass + R=green + bull-bear≥2 應為 'buy', got '${action}'`,
    };
  }
  // 反向：action='buy' 必須滿足 T=pass + R=green + bull-bear≥2
  if (action === 'buy' && !(t === 'pass' && risk === 'green' && bull - bear >= 2)) {
    return {
      ok: false,
      reason: `action='buy' 必須滿足 T=pass + R=green + bull-bear≥2 (T=${t}, R=${risk}, bull-bear=${bull - bear})`,
    };
  }

  // sizeHint 與 Risk 對應：red=0 / yellow≤0.5 / green=1
  if (risk === 'red' && v.sizeHint !== 0) {
    return { ok: false, reason: `Risk='red' 必須 sizeHint=0, got ${v.sizeHint}` };
  }
  if (risk === 'yellow' && (v.sizeHint as number) > 0.5) {
    return { ok: false, reason: `Risk='yellow' 應降部位 sizeHint≤0.5, got ${v.sizeHint}` };
  }

  return { ok: true };
}

function makeValid(overrides: Partial<FinalDecision> = {}): FinalDecision {
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'decision',
    runId: 'rid-1',
    date: '2026-05-22',
    symbol: '2330.TW',
    action: 'buy',
    decisionPath: 'buy_signal',
    verdictsByAgent: {
      technical: 'pass', news: 'pass', chip: 'pass', fundamental: 'pass', risk: 'green',
    },
    bullScore: 12,
    bearScore: 8,
    sizeHint: 1.0,
    conflicts: [],
    overview: '4 面向支持 + 風控綠燈',
    verdictReason: 'buy_signal 命中',
    ...overrides,
  };
}

describe('Decision Agent 規則式決策表', () => {
  test('合法 buy 通過', () => {
    expect(validate(makeValid())).toEqual({ ok: true });
  });

  test('§0：Technical=fail 必須 action=skip', () => {
    const r = validate(makeValid({
      verdictsByAgent: { technical: 'fail', news: 'pass', chip: 'pass', fundamental: 'pass', risk: 'green' },
      action: 'watch',
      decisionPath: 'default_watch',
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Technical=');
  });

  test('§0：Technical=fail + 其他都 pass + Risk=green 仍必須 skip', () => {
    const r = validate(makeValid({
      verdictsByAgent: { technical: 'fail', news: 'pass', chip: 'pass', fundamental: 'pass', risk: 'green' },
      action: 'buy',
      decisionPath: 'buy_signal',
    }));
    expect(r.ok).toBe(false);
    // 應該 skip 但寫 buy
  });

  test('§0：Risk=red 必須 action=skip', () => {
    const r = validate(makeValid({
      verdictsByAgent: { technical: 'pass', news: 'pass', chip: 'pass', fundamental: 'pass', risk: 'red' },
      action: 'watch',
      decisionPath: 'default_watch',
      sizeHint: 0,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Risk='red'");
  });

  test('§0：buy_signal 需 bull - bear ≥ 2', () => {
    const r = validate(makeValid({
      bullScore: 8, bearScore: 8,
      action: 'buy',
      decisionPath: 'buy_signal',
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('bull-bear');
  });

  test('§0：compositeScore 欄位被 reject', () => {
    const r = validate({ ...makeValid(), compositeScore: 85 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('compositeScore forbidden');
  });

  test('Risk=red + sizeHint > 0 被 reject', () => {
    const r = validate(makeValid({
      verdictsByAgent: { technical: 'pass', news: 'pass', chip: 'pass', fundamental: 'pass', risk: 'red' },
      action: 'skip',
      decisionPath: 'risk_red',
      sizeHint: 0.3,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('sizeHint=0');
  });

  test('Risk=yellow + sizeHint > 0.5 被 reject', () => {
    const r = validate(makeValid({
      verdictsByAgent: { technical: 'pass', news: 'pass', chip: 'pass', fundamental: 'pass', risk: 'yellow' },
      action: 'watch',
      decisionPath: 'risk_yellow_watch',
      sizeHint: 0.8,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('sizeHint≤0.5');
  });

  test('正確的 risk_yellow_watch 通過', () => {
    const r = validate(makeValid({
      verdictsByAgent: { technical: 'pass', news: 'pass', chip: 'pass', fundamental: 'pass', risk: 'yellow' },
      action: 'watch',
      decisionPath: 'risk_yellow_watch',
      sizeHint: 0.5,
    }));
    expect(r).toEqual({ ok: true });
  });

  test('正確的 technical_fail 通過', () => {
    const r = validate(makeValid({
      verdictsByAgent: { technical: 'fail', news: 'pass', chip: 'pass', fundamental: 'pass', risk: 'green' },
      action: 'skip',
      decisionPath: 'technical_fail',
      sizeHint: 0,
    }));
    expect(r).toEqual({ ok: true });
  });

  test('verdictsByAgent 缺 key 被 reject', () => {
    const r = validate({
      ...makeValid(),
      verdictsByAgent: { technical: 'pass', news: 'pass', chip: 'pass', risk: 'green' },  // 缺 fundamental
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('fundamental');
  });

  test('sizeHint 越界被 reject', () => {
    const r = validate(makeValid({ sizeHint: 1.5 }));
    expect(r.ok).toBe(false);
  });
});
