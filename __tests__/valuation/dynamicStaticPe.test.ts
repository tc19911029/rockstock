import {
  computeDynamicPe,
  computeStaticPe,
  computeLastYearEps,
} from '@/lib/valuation/ttm';
import type { QuarterRow } from '@/lib/valuation/types';

describe('valuation/dynamicStaticPe', () => {
  it('computes dynamic PE = price / (latest quarterly EPS × 4)', () => {
    // 用戶範例：兆易創新 股價 514.18 / 收益（一）2.084 → 動態 PE ≈ 61.68
    expect(computeDynamicPe(514.18, 2.084)).toBeCloseTo(61.68, 1);
  });

  it('returns Infinity when latest quarter EPS <= 0', () => {
    expect(computeDynamicPe(100, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(computeDynamicPe(100, -1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('computes static PE = price / last year total EPS', () => {
    // 用戶範例：兆易創新 股價 514.18 / 市盈率靜 218.74 → 去年 EPS = 2.35
    // 反向驗證：給去年 EPS 2.35，靜態 PE 應該 ≈ 218.8
    expect(computeStaticPe(514.18, 2.35)).toBeCloseTo(218.8, 1);
  });

  it('returns Infinity when last year EPS <= 0', () => {
    expect(computeStaticPe(100, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('computes the latest complete prior fiscal year regardless of array offsets', () => {
    const quarters: QuarterRow[] = [
      // 最新年度只有 Q1；2025 四季完整，應採完整 2025 而不是 quarters[4..7]
      { quarter: '2026-03-31', revenue: 0, netIncome: 0, eps: 17.55 },
      { quarter: '2025-12-31', revenue: 0, netIncome: 0, eps: 16.0 },
      { quarter: '2025-09-30', revenue: 0, netIncome: 0, eps: 15.5 },
      { quarter: '2025-06-30', revenue: 0, netIncome: 0, eps: 19.18 },
      { quarter: '2025-03-31', revenue: 0, netIncome: 0, eps: 12.0 },
      { quarter: '2024-12-31', revenue: 0, netIncome: 0, eps: 11.0 },
      { quarter: '2024-09-30', revenue: 0, netIncome: 0, eps: 10.5 },
      { quarter: '2024-06-30', revenue: 0, netIncome: 0, eps: 9.5 },
    ];
    expect(computeLastYearEps(quarters)).toBeCloseTo(16 + 15.5 + 19.18 + 12, 2);
  });

  it('returns null when less than 8 quarters', () => {
    const quarters: QuarterRow[] = [
      { quarter: '2026-03-31', revenue: 0, netIncome: 0, eps: 17.55 },
    ];
    expect(computeLastYearEps(quarters)).toBeNull();
  });

  it('dynamic > TTM signals declining quarter (or one-time gain reversal)', () => {
    // 兆易創新對比：TTM PE 125.4 > 動態 PE 61.7
    // 代表動態 < TTM → 最新季 EPS 比過去四季平均高 → 獲利轉強
    const ttmEps = 4.10;
    const latestQ = 2.084;
    const ttmPe = 514.18 / ttmEps;       // 125.4
    const dynPe = computeDynamicPe(514.18, latestQ);  // 61.68
    expect(dynPe).toBeLessThan(ttmPe);   // 動 < TTM → 轉強
  });
});
