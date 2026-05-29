import {
  computeDilutedEps,
  computeDilutionRatio,
  sumAddedShares,
  buildDilutionResult,
} from '@/lib/valuation/dilution';
import type { ScenarioResult } from '@/lib/valuation/types';

describe('valuation/dilution', () => {
  it('computes diluted EPS = eps × original / new', () => {
    // 用戶範例：原 EPS 157，原 8137 萬股，新 8737 萬股 → 稀釋後 ≈ 157 × 0.9313 ≈ 146.2
    const d = computeDilutedEps(157, 8137, 8737);
    expect(d).toBeCloseTo(146.22, 1);
  });

  it('returns original EPS when newShares=0', () => {
    expect(computeDilutedEps(100, 1000, 0)).toBe(100);
  });

  it('computes dilution ratio', () => {
    // 600 / 8137 ≈ 7.37%
    expect(computeDilutionRatio(8137, 600)).toBeCloseTo(0.0737, 3);
  });

  it('sums added shares', () => {
    expect(sumAddedShares([
      { type: 'gdr', newShares: 600 },
      { type: 'convertible_bond', newShares: 200 },
    ])).toBe(800);
  });

  it('returns 0 for empty events', () => {
    expect(sumAddedShares([])).toBe(0);
  });

  it('builds full dilution result with three scenarios', () => {
    const s = (eps: number, fairPe: number): ScenarioResult => ({
      q2Eps: 0, q3Eps: 0, q4Eps: 0,
      fullYearEps: eps, forwardPe: 0, fairPe,
      fairPrice: eps * fairPe, upside: 0,
    });
    const r = buildDilutionResult(8137, 600, {
      pessimistic: s(123, 40),
      base: s(157, 50),
      optimistic: s(201, 60),
    });
    expect(r).not.toBeNull();
    expect(r!.ratio).toBeCloseTo(0.0737, 3);
    expect(r!.baseDilutedEps).toBeCloseTo(146.22, 1);
    // 用戶範例（取整）：146 × 50 = 7300；實際 146.22 × 50 = 7311（誤差 < 1%）
    expect(r!.baseDilutedPrice).toBeGreaterThanOrEqual(7300);
    expect(r!.baseDilutedPrice).toBeLessThan(7350);
  });

  it('returns null when no dilution', () => {
    const s: ScenarioResult = { q2Eps:0, q3Eps:0, q4Eps:0, fullYearEps:100, forwardPe:0, fairPe:30, fairPrice:3000, upside:0 };
    expect(buildDilutionResult(1000, 0, { pessimistic: s, base: s, optimistic: s })).toBeNull();
  });
});
