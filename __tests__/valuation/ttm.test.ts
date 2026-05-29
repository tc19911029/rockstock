import { computeTTM, computeTTMPe } from '@/lib/valuation/ttm';
import type { QuarterRow } from '@/lib/valuation/types';

describe('valuation/ttm', () => {
  const quarters: QuarterRow[] = [
    { quarter: '2026-03-31', revenue: 41.85, netIncome: 14.28, eps: 17.55 },
    { quarter: '2025-12-31', revenue: 38.0,  netIncome: 13.0,  eps: 16.0 },
    { quarter: '2025-09-30', revenue: 36.0,  netIncome: 12.5,  eps: 15.5 },
    { quarter: '2025-06-30', revenue: 35.0,  netIncome: 12.0,  eps: 19.18 },
  ];

  it('computes TTM EPS = sum of last 4 quarters', () => {
    const r = computeTTM(quarters);
    expect(r).not.toBeNull();
    expect(r!.ttmEps).toBeCloseTo(17.55 + 16.0 + 15.5 + 19.18, 2);
    expect(r!.quartersUsed).toBe(4);
  });

  it('computes TTM net margin', () => {
    const r = computeTTM(quarters)!;
    const totalRev = 41.85 + 38 + 36 + 35;
    const totalNet = 14.28 + 13 + 12.5 + 12;
    expect(r.ttmRevenue).toBeCloseTo(totalRev, 2);
    expect(r.ttmNetMargin).toBeCloseTo(totalNet / totalRev, 4);
  });

  it('returns null when fewer than 4 quarters', () => {
    expect(computeTTM(quarters.slice(0, 3))).toBeNull();
  });

  it('TTM PE = price / TTM EPS', () => {
    // 用戶範例：世芯-KY 股價 4500 / TTM EPS 68.23 ≈ 65.95
    expect(computeTTMPe(4500, 68.23)).toBeCloseTo(65.95, 1);
  });

  it('TTM PE returns Infinity when eps <= 0', () => {
    expect(computeTTMPe(100, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(computeTTMPe(100, -5)).toBe(Number.POSITIVE_INFINITY);
  });
});
