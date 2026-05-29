import {
  reverseEngineerH2Revenue,
  detectOverlyOptimistic,
  describeOptimisticFlag,
} from '@/lib/valuation/scenario';

describe('valuation/reverseEngineering', () => {
  describe('reverseEngineerH2Revenue', () => {
    it('reverses to H2 required revenue from full-year EPS target', () => {
      // 用戶範例：世芯-KY
      //   全年 EPS 目標 145、Q1 EPS 17.55、Q2 EPS 31.9、股數 0.8137 億、H2 淨利率 35%
      //   → H2 所需 EPS = 145 - 17.55 - 31.9 = 95.55
      //   → H2 所需稅後淨利 = 95.55 × 0.8137 = 77.75 億
      //   → H2 所需營收 = 77.75 / 0.35 = 222.1 億
      const r = reverseEngineerH2Revenue({
        targetFullYearEps: 145,
        q1Eps: 17.55,
        q2Eps: 31.9,
        shares: 0.8137,
        h2NetMargin: 0.35,
      });
      expect(r).not.toBeNull();
      expect(r!.h2RequiredEps).toBeCloseTo(95.55, 1);
      expect(r!.h2RequiredNetIncome).toBeCloseTo(77.75, 0);
      expect(r!.h2RequiredRevenue).toBeCloseTo(222.1, 0);
    });

    it('splits H2 revenue 47:53 between Q3:Q4', () => {
      const r = reverseEngineerH2Revenue({
        targetFullYearEps: 145, q1Eps: 17.55, q2Eps: 31.9, shares: 0.8137, h2NetMargin: 0.35,
      })!;
      // 47:53 of 222.1
      expect(r.q3SuggestedRevenue).toBeCloseTo(222.1 * 0.47, 0);
      expect(r.q4SuggestedRevenue).toBeCloseTo(222.1 * 0.53, 0);
      expect(r.q3MonthlyAvg).toBeCloseTo(222.1 * 0.47 / 3, 1);
    });

    it('returns null when target EPS unreachable (Q1+Q2 already > target)', () => {
      const r = reverseEngineerH2Revenue({
        targetFullYearEps: 40, q1Eps: 17.55, q2Eps: 31.9, shares: 0.8137, h2NetMargin: 0.35,
      });
      expect(r).toBeNull();
    });

    it('returns null when shares or netMargin invalid', () => {
      expect(reverseEngineerH2Revenue({
        targetFullYearEps: 100, q1Eps: 10, q2Eps: 20, shares: 0, h2NetMargin: 0.3,
      })).toBeNull();
      expect(reverseEngineerH2Revenue({
        targetFullYearEps: 100, q1Eps: 10, q2Eps: 20, shares: 1, h2NetMargin: 0,
      })).toBeNull();
    });
  });

  describe('detectOverlyOptimistic', () => {
    it('flags Q3 revenue jump >50% vs Q2', () => {
      const flags = detectOverlyOptimistic({
        q1Revenue: 41.85, q1NetMargin: 0.341,
        q2Revenue: 70, q3Revenue: 120, q4Revenue: 130,
        q2NetMargin: 0.34, q3NetMargin: 0.34, q4NetMargin: 0.34,
        fullYearEps: 130,
      });
      expect(flags).toContain('q3_revenue_jump_over_50pct_vs_q2');
    });

    it('flags margin > Q1 + 3pp', () => {
      const flags = detectOverlyOptimistic({
        q1Revenue: 41.85, q1NetMargin: 0.341,
        q2Revenue: 60, q3Revenue: 80, q4Revenue: 90,
        q2NetMargin: 0.34, q3NetMargin: 0.38, q4NetMargin: 0.39,
        fullYearEps: 130,
      });
      expect(flags).toContain('q3_margin_above_q1_by_3pp');
      expect(flags).toContain('q4_margin_above_q1_by_3pp');
    });

    it('flags fullYearEps > consensus upper × 115%', () => {
      const flags = detectOverlyOptimistic({
        q1Revenue: 41.85, q1NetMargin: 0.341,
        q2Revenue: 60, q3Revenue: 70, q4Revenue: 80,
        q2NetMargin: 0.34, q3NetMargin: 0.34, q4NetMargin: 0.34,
        fullYearEps: 200, marketConsensusEpsUpper: 150,
      });
      expect(flags).toContain('fullyear_eps_above_consensus_upper_by_15pct');
    });

    it('returns empty when within bounds', () => {
      // 中性情境：所有假設都在合理範圍內
      const flags = detectOverlyOptimistic({
        q1Revenue: 41.85, q1NetMargin: 0.341,
        q2Revenue: 76, q3Revenue: 105, q4Revenue: 115,  // Q3/Q2 = 1.38 < 1.5
        q2NetMargin: 0.34, q3NetMargin: 0.35, q4NetMargin: 0.35,  // 都 ≤ Q1 + 3pp
        fullYearEps: 145, marketConsensusEpsUpper: 145,
      });
      expect(flags).toEqual([]);
    });

    it('Q4 jump >20% vs Q3 also flagged', () => {
      const flags = detectOverlyOptimistic({
        q1Revenue: 41.85, q1NetMargin: 0.341,
        q2Revenue: 60, q3Revenue: 100, q4Revenue: 130,  // 130/100 = 1.3 > 1.2
        q2NetMargin: 0.34, q3NetMargin: 0.34, q4NetMargin: 0.34,
        fullYearEps: 130,
      });
      expect(flags).toContain('q4_revenue_jump_over_20pct_vs_q3');
    });
  });

  describe('describeOptimisticFlag', () => {
    it('returns Chinese label', () => {
      expect(describeOptimisticFlag('q3_revenue_jump_over_50pct_vs_q2')).toContain('Q3');
      expect(describeOptimisticFlag('q3_margin_above_q1_by_3pp')).toContain('3pp');
    });
  });
});
