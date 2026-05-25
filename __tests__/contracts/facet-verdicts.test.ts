/**
 * Contract test: computeFacetVerdicts 規則式 4 verdict 推算
 */

import { computeFacetVerdicts } from '@/lib/decision/computeFacetVerdicts';

describe('computeFacetVerdicts', () => {
  describe('技術 verdict', () => {
    test('六條件 6/6 + 無戒律 → pass', () => {
      const r = computeFacetVerdicts({ sixConditionsScore: 6, prohibitionHit: false });
      expect(r.technical).toBe('pass');
      expect(r.hints.technical).toBe('六條件 6/6');
    });
    test('六條件 6/6 + 戒律觸發 → 降級 watch', () => {
      const r = computeFacetVerdicts({ sixConditionsScore: 6, prohibitionHit: true });
      expect(r.technical).toBe('watch');
      expect(r.hints.technical).toContain('戒律觸發');
    });
    test('六條件 5/6 → watch', () => {
      const r = computeFacetVerdicts({ sixConditionsScore: 5 });
      expect(r.technical).toBe('watch');
    });
    test('六條件 5/6 + 戒律 → 降級 fail', () => {
      const r = computeFacetVerdicts({ sixConditionsScore: 5, prohibitionHit: true });
      expect(r.technical).toBe('fail');
    });
    test('六條件 4/6 → fail', () => {
      expect(computeFacetVerdicts({ sixConditionsScore: 4 }).technical).toBe('fail');
    });
    test('無資料 → fail', () => {
      expect(computeFacetVerdicts({}).technical).toBe('fail');
    });
  });

  describe('消息 verdict', () => {
    test('≥2 節提及 + 高共識 → pass', () => {
      const r = computeFacetVerdicts({ youtubeMentionCount: 3, youtubeInHighConsensus: true });
      expect(r.news).toBe('pass');
      expect(r.hints.news).toContain('高共識');
    });
    test('2 節提及但無高共識 → watch', () => {
      expect(computeFacetVerdicts({ youtubeMentionCount: 2, youtubeInHighConsensus: false }).news).toBe('watch');
    });
    test('1 節提及 → watch', () => {
      expect(computeFacetVerdicts({ youtubeMentionCount: 1 }).news).toBe('watch');
    });
    test('0 節提及 → fail', () => {
      expect(computeFacetVerdicts({ youtubeMentionCount: 0 }).news).toBe('fail');
    });
    test('無 YouTube 資料 → fail + hint', () => {
      const r = computeFacetVerdicts({});
      expect(r.news).toBe('fail');
      expect(r.hints.news).toBe('無 YouTube 提及');
    });
  });

  describe('籌碼 verdict', () => {
    test('chipScore 75 → pass', () => {
      expect(computeFacetVerdicts({ chipScore: 75 }).chip).toBe('pass');
    });
    test('chipScore 50 → watch', () => {
      expect(computeFacetVerdicts({ chipScore: 50 }).chip).toBe('watch');
    });
    test('chipScore 30 → fail', () => {
      expect(computeFacetVerdicts({ chipScore: 30 }).chip).toBe('fail');
    });
    test('chipScore null → fail + hint「無籌碼資料」', () => {
      const r = computeFacetVerdicts({ chipScore: null });
      expect(r.chip).toBe('fail');
      expect(r.hints.chip).toBe('無籌碼資料');
    });
    test('邊界值 70 → pass、40 → watch、39 → fail', () => {
      expect(computeFacetVerdicts({ chipScore: 70 }).chip).toBe('pass');
      expect(computeFacetVerdicts({ chipScore: 40 }).chip).toBe('watch');
      expect(computeFacetVerdicts({ chipScore: 39 }).chip).toBe('fail');
    });
  });

  describe('基本 verdict', () => {
    test('EPS YoY +20 + 營收 YoY +15 → pass', () => {
      const r = computeFacetVerdicts({ epsYoY: 20, revenueYoY: 15 });
      expect(r.fundamental).toBe('pass');
      expect(r.hints.fundamental).toContain('20.0%');
    });
    test('EPS +10 + 營收 -5 → watch (one positive)', () => {
      expect(computeFacetVerdicts({ epsYoY: 10, revenueYoY: -5 }).fundamental).toBe('watch');
    });
    test('EPS -5 + 營收 -10 → fail', () => {
      expect(computeFacetVerdicts({ epsYoY: -5, revenueYoY: -10 }).fundamental).toBe('fail');
    });
    test('無任何基本面資料 → fail + hint「無基本面資料」', () => {
      const r = computeFacetVerdicts({});
      expect(r.fundamental).toBe('fail');
      expect(r.hints.fundamental).toBe('無基本面資料');
    });
    test('EPS 有、營收 null → fallback 0 → watch（EPS > 0）', () => {
      const r = computeFacetVerdicts({ epsYoY: 5, revenueYoY: null });
      expect(r.fundamental).toBe('watch');
    });
  });

  describe('完整 case', () => {
    test('優質股 — 全 pass', () => {
      const r = computeFacetVerdicts({
        sixConditionsScore: 6, prohibitionHit: false,
        youtubeMentionCount: 3, youtubeInHighConsensus: true,
        chipScore: 85,
        epsYoY: 25, revenueYoY: 18,
      });
      expect(r.technical).toBe('pass');
      expect(r.news).toBe('pass');
      expect(r.chip).toBe('pass');
      expect(r.fundamental).toBe('pass');
    });

    test('地雷股 — 全 fail', () => {
      const r = computeFacetVerdicts({
        sixConditionsScore: 2, prohibitionHit: true,
        youtubeMentionCount: 0,
        chipScore: 20,
        epsYoY: -30, revenueYoY: -25,
      });
      expect(r.technical).toBe('fail');
      expect(r.news).toBe('fail');
      expect(r.chip).toBe('fail');
      expect(r.fundamental).toBe('fail');
    });

    test('完全無資料 — 全 fail', () => {
      const r = computeFacetVerdicts({});
      expect(r.technical).toBe('fail');
      expect(r.news).toBe('fail');
      expect(r.chip).toBe('fail');
      expect(r.fundamental).toBe('fail');
    });
  });
});
