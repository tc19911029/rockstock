/**
 * Contract test: 4 面向候選池加權排序 single source of truth (B3)
 *
 * 驗證 CLAUDE.md Fundamental Rule #10 — 選股邏輯單一事實
 *
 * 規則：
 *   - POOL_WEIGHTS 總和 = 1.0（總分上限 100）
 *   - computeFacetScores 純函數：相同 input → 相同 output
 *   - totalScore = Σ(facet × weight)，round 到整數
 *   - 沒過該面向（c.sources[name] missing）→ 該 facet 分 = 0
 *   - normalize 規則：technical/news clip ≤100、chip/fundamental 直接用
 */
import {
  POOL_WEIGHTS,
  POOL_MIN_SOURCE_COUNT_DEFAULT,
  computeFacetScores,
} from '@/lib/agents/candidates/poolWeights';
import type { Candidate } from '@/lib/agents/candidates/types';
import type { MarketId } from '@/lib/scanner/types';

const MARKET: MarketId = 'TW';

function makeCandidate(opts: {
  symbol?: string;
  hasTechnical?: boolean;
  hasYoutube?: boolean;
  hasChip?: boolean;
  hasFundamental?: boolean;
  technicalTracksCount?: number;
  youtubeMentionCount?: number;
  chipScore?: number;
  fundamentalScore?: number;
}): Candidate {
  const sources: Candidate['sources'] = {};
  if (opts.hasTechnical) sources.technical = { tracks: ['B'] as never, score: 80 } as never;
  if (opts.hasYoutube) sources.youtube = { mentionCount: opts.youtubeMentionCount ?? 1 } as never;
  if (opts.hasChip) sources.chip = { score: opts.chipScore ?? 50 } as never;
  if (opts.hasFundamental) sources.fundamental = { score: opts.fundamentalScore ?? 50 } as never;
  const sourceCount =
    (opts.hasTechnical ? 1 : 0) +
    (opts.hasYoutube ? 1 : 0) +
    (opts.hasChip ? 1 : 0) +
    (opts.hasFundamental ? 1 : 0);
  return {
    symbol: opts.symbol ?? 'TEST.TW',
    name: 'TEST',
    market: MARKET,
    sources,
    sourceCount,
    strengthSignals: {
      technicalTracksCount: opts.technicalTracksCount ?? 0,
      youtubeMentionCount:  opts.youtubeMentionCount ?? 0,
      chipScore:            opts.chipScore ?? 0,
      fundamentalScore:     opts.fundamentalScore ?? 0,
    },
  };
}

describe('Pool weighted ranking contracts (B3)', () => {
  describe('POOL_WEIGHTS 設定', () => {
    test('權重總和必須 = 1.0（總分上限 100）', () => {
      const sum = POOL_WEIGHTS.technical + POOL_WEIGHTS.youtube + POOL_WEIGHTS.chip + POOL_WEIGHTS.fundamental;
      expect(sum).toBeCloseTo(1.0, 5);
    });

    test('預設 min source count = 3（≥3 面向共識才進入結果）', () => {
      expect(POOL_MIN_SOURCE_COUNT_DEFAULT).toBe(3);
    });

    test('每個權重 ∈ [0, 1]', () => {
      for (const w of Object.values(POOL_WEIGHTS)) {
        expect(w).toBeGreaterThan(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('computeFacetScores 純函數', () => {
    test('全部面向都過 + 滿分 → total = 100', () => {
      const c = makeCandidate({
        hasTechnical: true, hasYoutube: true, hasChip: true, hasFundamental: true,
        technicalTracksCount: 2,   // ×50 = 100
        youtubeMentionCount: 4,    // ×25 = 100
        chipScore: 100,
        fundamentalScore: 100,
      });
      const s = computeFacetScores(c);
      expect(s.technical).toBe(100);
      expect(s.news).toBe(100);
      expect(s.chip).toBe(100);
      expect(s.fundamental).toBe(100);
      expect(s.total).toBe(100);
    });

    test('沒過該面向 → 該 facet 分 = 0', () => {
      const c = makeCandidate({
        hasTechnical: false, hasYoutube: true, hasChip: true, hasFundamental: false,
        youtubeMentionCount: 2, chipScore: 80,
      });
      const s = computeFacetScores(c);
      expect(s.technical).toBe(0);
      expect(s.news).toBe(50);  // 2 × 25
      expect(s.chip).toBe(80);
      expect(s.fundamental).toBe(0);
      const expected = Math.round(50 * POOL_WEIGHTS.youtube + 80 * POOL_WEIGHTS.chip);
      expect(s.total).toBe(expected);
    });

    test('technical tracksCount 過量 clip ≤100', () => {
      const c = makeCandidate({ hasTechnical: true, technicalTracksCount: 10 });
      expect(computeFacetScores(c).technical).toBe(100);
    });

    test('youtube mentionCount 過量 clip ≤100', () => {
      const c = makeCandidate({ hasYoutube: true, youtubeMentionCount: 8 });
      expect(computeFacetScores(c).news).toBe(100);
    });

    test('total 公式 = Σ(facet × weight) round', () => {
      const c = makeCandidate({
        hasTechnical: true, hasYoutube: true, hasChip: true, hasFundamental: true,
        technicalTracksCount: 1,   // → 50
        youtubeMentionCount: 2,    // → 50
        chipScore: 60,
        fundamentalScore: 40,
      });
      const s = computeFacetScores(c);
      const expected = Math.round(
        50 * POOL_WEIGHTS.technical +
        50 * POOL_WEIGHTS.youtube +
        60 * POOL_WEIGHTS.chip +
        40 * POOL_WEIGHTS.fundamental,
      );
      expect(s.total).toBe(expected);
    });

    test('相同 input → 相同 output（純函數）', () => {
      const c = makeCandidate({
        hasTechnical: true, hasChip: true,
        technicalTracksCount: 1, chipScore: 70,
      });
      const a = computeFacetScores(c);
      const b = computeFacetScores(c);
      expect(a).toEqual(b);
    });
  });

  describe('B3 排序行為', () => {
    test('全 4/4 通過時，weighted sort 對「分高」者排前', () => {
      const high = makeCandidate({
        symbol: 'HIGH.TW',
        hasTechnical: true, hasYoutube: true, hasChip: true, hasFundamental: true,
        technicalTracksCount: 2, youtubeMentionCount: 4, chipScore: 90, fundamentalScore: 80,
      });
      const low = makeCandidate({
        symbol: 'LOW.TW',
        hasTechnical: true, hasYoutube: true, hasChip: true, hasFundamental: true,
        technicalTracksCount: 1, youtubeMentionCount: 1, chipScore: 30, fundamentalScore: 30,
      });
      const sortedDesc = [high, low]
        .map(c => ({ ...c, scores: computeFacetScores(c) }))
        .sort((a, b) => b.scores.total - a.scores.total);
      expect(sortedDesc[0].symbol).toBe('HIGH.TW');
      expect(sortedDesc[1].symbol).toBe('LOW.TW');
      expect(sortedDesc[0].scores.total).toBeGreaterThan(sortedDesc[1].scores.total);
    });

    test('「技術 95 但 0 面向過」實際不存在 — sourceCount=0 不會進 candidates', () => {
      // sourceCount=0 表示沒任何 source 命中、不會進 pool。但 if 真的把分數塞進
      // strengthSignals 卻沒 sources，scores 仍然全 0（因為要過 source 才採用）
      const fake = makeCandidate({
        hasTechnical: false, hasYoutube: false, hasChip: false, hasFundamental: false,
        technicalTracksCount: 99, chipScore: 99, fundamentalScore: 99,
      });
      const s = computeFacetScores(fake);
      expect(s.technical).toBe(0);
      expect(s.chip).toBe(0);
      expect(s.fundamental).toBe(0);
      expect(s.total).toBe(0);
    });
  });
});
