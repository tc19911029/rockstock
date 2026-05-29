import { computeScenario, computeAllScenarios, deriveConclusion } from '@/lib/valuation/scenario';
import type { QuarterRow, ScenarioAssumption, PeRange } from '@/lib/valuation/types';

describe('valuation/scenario', () => {
  // 用戶範例：世芯-KY Q1 EPS 17.55，股數 0.8137 億，股價 4500
  const quarters: QuarterRow[] = [
    { quarter: '2026-03-31', revenue: 41.85, netIncome: 14.28, eps: 17.55 },
  ];
  const shares = 0.8137;

  it('computes pessimistic scenario matches user spec', () => {
    // 悲觀：Q2 (21.33 4月 + 22 5月 + 25 6月 = 68.33) × 32% = 21.87 億 / 0.8137 ≈ 26.88
    //       Q3 90 × 33% = 29.7 / 0.8137 ≈ 36.5
    //       Q4 100 × 34% = 34 / 0.8137 ≈ 41.8
    //       全年 = 17.55 + 26.9 + 36.5 + 41.8 ≈ 122.75
    const result = computeScenario(
      quarters,
      {
        partialQuarterRevenue: 21.33,
        q2Revenue: 47,           // 22 + 25
        q3Revenue: 90,
        q4Revenue: 100,
        q2NetMargin: 0.32,
        q3NetMargin: 0.33,
        q4NetMargin: 0.34,
      },
      shares,
      40,
      4500,
    );
    expect(result.q2Eps).toBeCloseTo(26.88, 0);
    expect(result.q3Eps).toBeCloseTo(36.5, 0);
    expect(result.q4Eps).toBeCloseTo(41.8, 0);
    expect(result.fullYearEps).toBeCloseTo(122.75, 0);
    // Forward PE = 4500 / 122.75 ≈ 36.66
    expect(result.forwardPe).toBeCloseTo(36.66, 0);
    // 合理價 = 122.75 × 40 ≈ 4910
    expect(result.fairPrice).toBeCloseTo(4910, -1);
  });

  it('computes base scenario matches user spec', () => {
    // 中性：Q2 (21.33 + 25 + 30 = 76.33) × 34% = 25.95 / 0.8137 ≈ 31.9
    //       Q3 120 × 35% = 42 / 0.8137 ≈ 51.6
    //       Q4 130 × 35% = 45.5 / 0.8137 ≈ 55.9
    //       全年 ≈ 17.55 + 31.9 + 51.6 + 55.9 = 156.95
    const result = computeScenario(
      quarters,
      {
        partialQuarterRevenue: 21.33,
        q2Revenue: 55,           // 25 + 30
        q3Revenue: 120,
        q4Revenue: 130,
        q2NetMargin: 0.34,
        q3NetMargin: 0.35,
        q4NetMargin: 0.35,
      },
      shares,
      50,
      4500,
    );
    expect(result.fullYearEps).toBeCloseTo(156.95, 0);
    expect(result.fairPrice).toBeCloseTo(7850, -1);
    // upside ≈ 7850 / 4500 - 1 ≈ 0.744
    expect(result.upside).toBeCloseTo(0.744, 1);
  });

  it('handles missing shares', () => {
    const r = computeScenario(quarters, { q2Revenue: 50, q2NetMargin: 0.3 }, 0, 30, 1000);
    expect(r.fullYearEps).toBe(0);
    expect(r.forwardPe).toBe(Number.POSITIVE_INFINITY);
  });

  it('computeAllScenarios returns three scenarios', () => {
    const a: ScenarioAssumption = { q2Revenue: 50, q3Revenue: 60, q4Revenue: 70, q2NetMargin: 0.3, q3NetMargin: 0.3, q4NetMargin: 0.3 };
    const pe: PeRange = { pessimistic: 30, base: 40, optimistic: 50 };
    const r = computeAllScenarios(quarters, { pessimistic: a, base: a, optimistic: a }, shares, pe, 4500);
    expect(r.pessimistic.fairPe).toBe(30);
    expect(r.base.fairPe).toBe(40);
    expect(r.optimistic.fairPe).toBe(50);
  });

  it('derives conclusion correctly', () => {
    const make = (forwardPe: number, fairPe: number) => ({
      q2Eps: 0, q3Eps: 0, q4Eps: 0, fullYearEps: 100, forwardPe, fairPe, fairPrice: 0, upside: 0,
    });
    expect(deriveConclusion(make(20, 40))).toBe('undervalued'); // 0.5 < 0.8
    expect(deriveConclusion(make(40, 40))).toBe('fair');         // 1.0
    expect(deriveConclusion(make(60, 40))).toBe('overvalued');  // 1.5 > 1.2
  });
});
