/**
 * lib/analysis/dimensionScore.ts — 基本面 / 估值維度評分
 */

import {
  scoreFundamental,
  scoreValuation,
  fundamentalValuationConclusion,
} from '@/lib/analysis/dimensionScore';

describe('scoreFundamental', () => {
  it('雙位數成長 + 高毛利/ROE → 高分', () => {
    const d = scoreFundamental({ revenueYoY: 30, epsYoY: 25, grossMargin: 45, netMargin: 25, per: 15, roePct: 22 });
    expect(d.score).not.toBeNull();
    expect(d.score!).toBeGreaterThanOrEqual(75);
    expect(d.note).toMatch(/營收YoY/);
  });
  it('衰退 → 低分', () => {
    expect(scoreFundamental({ revenueYoY: -15, epsYoY: -20, grossMargin: 8, netMargin: -2, per: null, roePct: -5 }).score!).toBeLessThan(45);
  });
  it('全缺 → null', () => {
    expect(scoreFundamental({ revenueYoY: null, epsYoY: null, grossMargin: null, netMargin: null, per: null, roePct: null }).score).toBeNull();
  });
});

describe('scoreValuation', () => {
  it('深度 undervalued → 偏低、高分', () => {
    const v = scoreValuation({ conclusion: 'undervalued', baseUpside: null, per: null, reasonablePeBase: null });
    expect(v.score).toBe(85);
    expect(v.label).toBe('偏低');
  });
  it('深度 overvalued → 偏貴、低分', () => {
    const v = scoreValuation({ conclusion: 'overvalued', baseUpside: null, per: null, reasonablePeBase: null });
    expect(v.label).toBe('偏貴');
    expect(v.score!).toBeLessThan(40);
  });
  it('base 情境大幅上漲空間 → 偏低', () => {
    expect(scoreValuation({ conclusion: null, baseUpside: 0.4, per: null, reasonablePeBase: null }).label).toBe('偏低');
  });
  it('現價遠高於中性合理價 → 偏貴', () => {
    expect(scoreValuation({ conclusion: null, baseUpside: -0.3, per: null, reasonablePeBase: null }).label).toBe('偏貴');
  });
  it('PER 低於產業合理 PE → 偏低', () => {
    const v = scoreValuation({ conclusion: null, baseUpside: null, per: 10, reasonablePeBase: 20 });
    expect(v.label).toBe('偏低');
    expect(v.score!).toBeGreaterThanOrEqual(70);
  });
  it('全缺 → null', () => {
    expect(scoreValuation({ conclusion: null, baseUpside: null, per: null, reasonablePeBase: null }).score).toBeNull();
  });
});

describe('fundamentalValuationConclusion', () => {
  it('組合估值定位 + 基本面強弱', () => {
    const f = scoreFundamental({ revenueYoY: 30, epsYoY: 25, grossMargin: 45, netMargin: 25, per: 15, roePct: 22 });
    const v = scoreValuation({ conclusion: 'undervalued', baseUpside: null, per: null, reasonablePeBase: null });
    const c = fundamentalValuationConclusion(f, v);
    expect(c).toContain('估值偏低');
    expect(c).toContain('基本面');
  });
  it('全缺 → 資料有限', () => {
    const f = scoreFundamental({ revenueYoY: null, epsYoY: null, grossMargin: null, netMargin: null, per: null, roePct: null });
    const v = scoreValuation({ conclusion: null, baseUpside: null, per: null, reasonablePeBase: null });
    expect(fundamentalValuationConclusion(f, v)).toContain('資料有限');
  });
});
