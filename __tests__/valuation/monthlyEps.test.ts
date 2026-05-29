import { estimateMonthlyEps, inferSharesFromEps } from '@/lib/valuation/monthlyEps';

describe('valuation/monthlyEps', () => {
  it('estimates monthly EPS = revenue × netMargin / shares', () => {
    // 用戶範例：世芯-KY 4 月 = 21.33 億 × 34.1% / 0.8137 億股 ≈ 8.94
    const eps = estimateMonthlyEps(21.33, 0.341, 0.8137);
    expect(eps).toBeCloseTo(8.94, 1);
  });

  it('returns 0 when shares <= 0', () => {
    expect(estimateMonthlyEps(100, 0.3, 0)).toBe(0);
    expect(estimateMonthlyEps(100, 0.3, -1)).toBe(0);
  });

  it('returns 0 when netMargin <= 0', () => {
    expect(estimateMonthlyEps(100, 0, 0.5)).toBe(0);
    expect(estimateMonthlyEps(100, -0.05, 0.5)).toBe(0);
  });

  it('infers shares from quarterly net income / EPS', () => {
    // 用戶範例：14.28 億 / 17.55 ≈ 0.8137 億股
    expect(inferSharesFromEps(14.28, 17.55)).toBeCloseTo(0.8137, 3);
  });

  it('returns 0 when eps <= 0', () => {
    expect(inferSharesFromEps(100, 0)).toBe(0);
  });
});
