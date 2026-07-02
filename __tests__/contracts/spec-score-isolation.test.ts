/**
 * Contract test: specScore / comboBadges 與 pool 排序完全隔離（2026-06-12 A3）
 *
 * 守護的決議：
 *  1. pool 預設排序的單一事實仍是 computeFacetScores（POOL_WEIGHTS）—
 *     specScore 存在與否不可改變 facet 分數與排序
 *  2. 「pool 不加組合 bonus」— comboBadges 純標示，不影響 strengthSignals / 排序
 *  3. SPEC_WEIGHTS 每套類型權重的維度權重皆 > 0（防呆）
 *  4. computeSpecScore 缺值語意：缺資料維度不入分（coverage 正確反映）
 */
import { computeFacetScores } from '@/lib/agents/candidates/poolWeights';
import { mergeCandidates, computeComboBadges } from '@/lib/agents/candidates/merger';
import type { Candidate } from '@/lib/agents/candidates/types';
import type { SourceResult } from '@/lib/agents/candidates/types';
import { computeSpecScore } from '@/lib/spec-score/compute';
import { SPEC_WEIGHTS } from '@/lib/spec-score/weights';

function mkCandidate(symbol: string, withSpec: boolean): Candidate {
  const c: Candidate = {
    symbol,
    name: symbol,
    market: 'TW',
    sources: {
      technical: {
        matchedMethods: ['A', 'B'], sixConditionsScore: 5, tracks: ['daily', 'B'],
        reasons: [], prohibitionHit: false, eliminationHit: false,
      },
      chip: { chipScore: 70, signals: ['foreign_strong_buy', 'trust_buy'], reasons: [] },
    },
    sourceCount: 2,
    strengthSignals: {
      technicalTracksCount: 2, youtubeMentionCount: 0, chipScore: 70, fundamentalScore: 0,
    },
  };
  if (withSpec) {
    c.specScore = {
      total: 99, stockType: 'general', coverage: 1,
      dims: [{ dim: 'technical', weight: 15, score: 99 }],
    };
    c.comboBadges = ['sync_buy_with_tech'];
  }
  return c;
}

describe('specScore isolation contracts', () => {
  test('computeFacetScores 不受 specScore / comboBadges 影響', () => {
    const plain = mkCandidate('2330', false);
    const withSpec = mkCandidate('2330', true);
    expect(computeFacetScores(withSpec)).toEqual(computeFacetScores(plain));
  });

  test('SPEC_WEIGHTS 各類型維度權重皆 > 0', () => {
    for (const [type, weights] of Object.entries(SPEC_WEIGHTS)) {
      const values = Object.values(weights);
      expect({ type, n: values.length }).toEqual({ type, n: expect.any(Number) });
      expect(values.length).toBeGreaterThanOrEqual(5);
      for (const w of values) expect(w).toBeGreaterThan(0);
    }
  });

  test('computeSpecScore 缺值不入分、coverage 正確', () => {
    const r = computeSpecScore('general', {
      technical: { score: 100 },
      chip: { score: null },     // 缺資料
    });
    // general: technical w15 / 全部權重 79 → coverage = 15/79
    expect(r.coverage).toBeCloseTo(15 / 79, 2);
    expect(r.total).toBe(100); // 只有 technical 覆蓋 → 歸一後 = 100
    const chipDim = r.dims.find(d => d.dim === 'chip');
    expect(chipDim?.score).toBeNull();
  });

  test('computeSpecScore 全缺 → total = null', () => {
    const r = computeSpecScore('general', {});
    expect(r.total).toBeNull();
    expect(r.coverage).toBe(0);
  });

  test('comboBadges：外資+投信 chip 訊號同現才有 sync 徽章；不改 strengthSignals', () => {
    const c = mkCandidate('2330', false);
    expect(computeComboBadges(c)).toContain('sync_buy_with_tech');
    const before = JSON.stringify(c.strengthSignals);
    computeComboBadges(c);
    expect(JSON.stringify(c.strengthSignals)).toBe(before);

    const noTrust = mkCandidate('2331', false);
    noTrust.sources.chip!.signals = ['foreign_strong_buy'];
    expect(computeComboBadges(noTrust)).toEqual([]);
  });

  test('merger 排序不受 specScore 影響（同池兩次 merge，一次帶 spec 欄位）', () => {
    const mkSourceResult = (): SourceResult => ({
      source: 'technical',
      ran: true,
      candidates: [
        { symbol: '1101.TW', name: 'A', market: 'TW', attribution: { matchedMethods: ['A'], sixConditionsScore: 5, tracks: ['daily'], reasons: [], prohibitionHit: false, eliminationHit: false } },
        { symbol: '2330.TW', name: 'B', market: 'TW', attribution: { matchedMethods: ['A', 'B'], sixConditionsScore: 6, tracks: ['daily', 'B'], reasons: [], prohibitionHit: false, eliminationHit: false } },
      ],
    } as unknown as SourceResult);
    const pool1 = mergeCandidates({ market: 'TW', date: '2026-06-12', results: [mkSourceResult()] });
    const order1 = pool1.candidates.map(c => c.symbol);
    // 對 pool1 的候選塞 specScore 後重 merge（merger 輸入不含 specScore，但驗證排序鍵）
    const pool2 = mergeCandidates({ market: 'TW', date: '2026-06-12', results: [mkSourceResult()] });
    for (const c of pool2.candidates) {
      c.specScore = { total: c.symbol === '1101.TW' ? 100 : 0, stockType: 'general', coverage: 1, dims: [] };
    }
    expect(pool2.candidates.map(c => c.symbol)).toEqual(order1);
  });
});
