/**
 * Contract test：Portfolio 持股 + Review schema
 *
 * 守的規則：
 *   - PortfolioHolding：必填 symbol/name/market/entryDate/entryPrice/shares/status
 *   - PortfolioAction enum 合法：7 種
 *   - actionPath 與 action 對應（強規則：red → stop_loss）
 */

import {
  PORTFOLIO_SCHEMA_VERSION,
  PortfolioAction,
  PortfolioHolding,
  PortfolioHoldingReview,
} from '@/lib/agents/portfolio/types';

const VALID_ACTIONS: PortfolioAction[] = [
  'hold_strong', 'hold_observe', 'add', 'reduce', 'take_profit', 'stop_loss', 'no_add',
];

function validateHolding(d: unknown): { ok: true } | { ok: false; reason: string } {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not object' };
  const v = d as Record<string, unknown>;
  if (v.schemaVersion !== PORTFOLIO_SCHEMA_VERSION) return { ok: false, reason: 'schemaVersion ≠ 1' };
  if (typeof v.symbol !== 'string' || !v.symbol) return { ok: false, reason: 'symbol missing' };
  if (typeof v.name !== 'string' || !v.name) return { ok: false, reason: 'name missing' };
  if (v.market !== 'TW' && v.market !== 'CN') return { ok: false, reason: 'market invalid' };
  if (typeof v.entryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.entryDate)) {
    return { ok: false, reason: 'entryDate invalid' };
  }
  if (typeof v.entryPrice !== 'number' || v.entryPrice <= 0) return { ok: false, reason: 'entryPrice invalid' };
  if (typeof v.shares !== 'number' || v.shares <= 0) return { ok: false, reason: 'shares invalid' };
  if (v.status !== 'open' && v.status !== 'closed') return { ok: false, reason: 'status invalid' };
  if (v.status === 'closed') {
    if (typeof v.closedPrice !== 'number') return { ok: false, reason: 'closed but closedPrice missing' };
    if (typeof v.closeReason !== 'string' || !v.closeReason) return { ok: false, reason: 'closed but closeReason missing' };
  }
  return { ok: true };
}

function validateReview(d: unknown): { ok: true } | { ok: false; reason: string } {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not object' };
  const v = d as Record<string, unknown>;
  if (typeof v.symbol !== 'string') return { ok: false, reason: 'symbol missing' };
  if (typeof v.currentPrice !== 'number') return { ok: false, reason: 'currentPrice missing' };
  if (typeof v.returnPct !== 'number') return { ok: false, reason: 'returnPct missing' };
  if (typeof v.daysHeld !== 'number') return { ok: false, reason: 'daysHeld missing' };
  if (!VALID_ACTIONS.includes(v.action as PortfolioAction)) {
    return { ok: false, reason: `action invalid: ${v.action}` };
  }
  if (typeof v.actionPath !== 'string') return { ok: false, reason: 'actionPath missing' };
  if (typeof v.reasoning !== 'string') return { ok: false, reason: 'reasoning missing' };

  // 強規則：Risk=red → action 必為 stop_loss
  const risk = v.risk as { verdict?: string } | null | undefined;
  if (risk?.verdict === 'red' && v.action !== 'stop_loss') {
    return { ok: false, reason: `Risk=red 必須 action='stop_loss', got '${v.action}'` };
  }

  return { ok: true };
}

function makeHolding(o: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    schemaVersion: PORTFOLIO_SCHEMA_VERSION,
    symbol: '2330.TW', name: '台積電', market: 'TW',
    entryDate: '2026-05-22', entryPrice: 1000, shares: 1,
    status: 'open',
    createdAt: '2026-05-22T00:00:00Z',
    updatedAt: '2026-05-22T00:00:00Z',
    ...o,
  };
}

function makeReview(o: Partial<PortfolioHoldingReview> = {}): PortfolioHoldingReview {
  return {
    symbol: '2330.TW', name: '台積電', market: 'TW',
    entryDate: '2026-05-22', entryPrice: 1000, shares: 1,
    currentPrice: 1050, returnPct: 0.05, daysHeld: 1,
    technical: { verdict: 'pass', overview: '六條件 6/6', verdictReason: '多頭' },
    risk: { verdict: 'green', overview: '無觸發', verdictReason: '無事件' },
    news: { verdict: 'pass', overview: '正向', verdictReason: '法人喊買' },
    action: 'hold_strong',
    actionPath: 'tech_pass_green',
    reasoning: 'Technical pass + Risk green → hold_strong',
    keyPriceLevels: {},
    ...o,
  };
}

describe('Portfolio holding schema', () => {
  test('合法 holding 通過', () => {
    expect(validateHolding(makeHolding())).toEqual({ ok: true });
  });
  test('schemaVersion ≠ 1 被 reject', () => {
    expect(validateHolding({ ...makeHolding(), schemaVersion: 2 }).ok).toBe(false);
  });
  test('market invalid 被 reject', () => {
    expect(validateHolding({ ...makeHolding(), market: 'JP' }).ok).toBe(false);
  });
  test('entryPrice ≤ 0 被 reject', () => {
    expect(validateHolding({ ...makeHolding(), entryPrice: 0 }).ok).toBe(false);
  });
  test('closed 缺 closedPrice 被 reject', () => {
    expect(validateHolding({ ...makeHolding(), status: 'closed' }).ok).toBe(false);
  });
  test('closed 含 closedPrice + closeReason 通過', () => {
    expect(validateHolding(makeHolding({
      status: 'closed',
      closedAt: '2026-05-23T00:00:00Z',
      closedPrice: 1100, closeReason: 'target1 hit',
    }))).toEqual({ ok: true });
  });
});

describe('Portfolio review schema', () => {
  test('合法 review 通過', () => {
    expect(validateReview(makeReview())).toEqual({ ok: true });
  });
  test('action 非 enum 被 reject', () => {
    expect(validateReview({ ...makeReview(), action: 'sell' as unknown as PortfolioAction }).ok).toBe(false);
  });
  test('Risk=red 必須 action=stop_loss', () => {
    const r = validateReview(makeReview({
      risk: { verdict: 'red', overview: 'x', verdictReason: 'y' },
      action: 'hold_strong',
      actionPath: 'tech_pass_green',
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Risk=red");
  });
  test('Risk=red + action=stop_loss 通過', () => {
    const r = validateReview(makeReview({
      risk: { verdict: 'red', overview: 'x', verdictReason: 'y' },
      action: 'stop_loss',
      actionPath: 'risk_red_stop',
    }));
    expect(r).toEqual({ ok: true });
  });
  test('reasoning 缺被 reject', () => {
    expect(validateReview({ ...makeReview(), reasoning: undefined as unknown as string }).ok).toBe(false);
  });
  test('PortfolioAction enum 含 7 種', () => {
    expect(VALID_ACTIONS).toHaveLength(7);
    expect(VALID_ACTIONS).toContain('hold_strong');
    expect(VALID_ACTIONS).toContain('take_profit');
    expect(VALID_ACTIONS).toContain('stop_loss');
  });
});
