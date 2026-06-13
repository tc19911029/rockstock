import { isShortTermSuccess, SUCCESS_RULE, SUCCESS_RULE_VERSION } from '@/lib/cn-agents/successCriterion';
import type { RecoReturns } from '@/lib/backtest/eventReturns';

function r(d5: number | null): RecoReturns {
  return {
    d1: null, d2: null, d3: null, d4: null, d5, d10: null, d20: null, d60: null,
    mfe: null, mae: null,
    excess: { d1: null, d2: null, d3: null, d4: null, d5: null, d10: null, d20: null, d60: null },
    isOpen: true, lastTrackedDate: null, holdReturn: null, holdExcess: null,
  };
}

describe('successCriterion 凍結', () => {
  it('規則鎖定 d5 / +3% / v1', () => {
    expect(SUCCESS_RULE).toEqual({ horizon: 'd5', minPct: 3 });
    expect(SUCCESS_RULE_VERSION).toBe('v1');
  });
  it('d5 > 3 → 成功', () => { expect(isShortTermSuccess(r(3.1))).toBe(true); });
  it('d5 = 3 → 不成功（嚴格大於）', () => { expect(isShortTermSuccess(r(3))).toBe(false); });
  it('d5 < 3 → 不成功', () => { expect(isShortTermSuccess(r(-2))).toBe(false); });
  it('d5 缺值 → null（未知）', () => { expect(isShortTermSuccess(r(null))).toBeNull(); expect(isShortTermSuccess(null)).toBeNull(); });
});
