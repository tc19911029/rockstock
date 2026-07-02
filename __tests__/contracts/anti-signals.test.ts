/**
 * Contract test：統計型反指標目錄（lib/avoidance/antiSignals）
 *
 * 守的規則：
 *   - 目錄 id 唯一、severity/market 合法
 *   - evalAntiSignals 只在條件滿足時命中、缺資料不誤報
 *   - 「熱階段追漲停」「tier C」等高嚴重度反指標存在
 *   - 價量型避雷（長上影/爆量長黑）**不可**進反指標目錄（回測證實反向）
 */

import {
  ANTI_SIGNALS,
  evalAntiSignals,
  PRICE_VOLUME_NOT_AVOID_NOTE,
} from '@/lib/avoidance/antiSignals';

describe('反指標目錄完整性', () => {
  test('id 唯一', () => {
    const ids = ANTI_SIGNALS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('severity ∈ {high, medium}、market ∈ {TW, CN, both}', () => {
    for (const s of ANTI_SIGNALS) {
      expect(['high', 'medium']).toContain(s.severity);
      expect(['TW', 'CN', 'both']).toContain(s.market);
      expect(s.evidence.length).toBeGreaterThan(10);
    }
  });

  test('含關鍵高嚴重度反指標：熱階段打板 / hard_score高 / tier C', () => {
    const ids = ANTI_SIGNALS.map((s) => s.id);
    expect(ids).toContain('cn_daban_hot_phase');
    expect(ids).toContain('cn_hardscore_high');
    expect(ids).toContain('cn_tier_c');
  });

  test('價量型避雷不可進目錄（回測反向、不可當不買理由）', () => {
    const text = JSON.stringify(ANTI_SIGNALS);
    // 目錄不得把「長上影/爆量長黑/爆量收弱」列為反指標
    expect(text).not.toMatch(/長上影|爆量長黑|爆量收弱/);
    // 但教學備註必須明講它們反向、不可當避雷
    expect(PRICE_VOLUME_NOT_AVOID_NOTE).toMatch(/長上影|爆量長黑/);
    expect(PRICE_VOLUME_NOT_AVOID_NOTE).toMatch(/不是避雷|報酬更好|反而/);
  });
});

describe('evalAntiSignals 判定', () => {
  test('熱階段 + 追漲停 → 命中 cn_daban_hot_phase', () => {
    const hits = evalAntiSignals({ cnEmotionPhase: '主升', isLimitUpChase: true });
    expect(hits.some((h) => h.id === 'cn_daban_hot_phase')).toBe(true);
  });

  test('修復階段追漲停 → 不命中（唯一不虧的階段）', () => {
    const hits = evalAntiSignals({ cnEmotionPhase: '修復', isLimitUpChase: true });
    expect(hits.some((h) => h.id === 'cn_daban_hot_phase')).toBe(false);
  });

  test('熱階段但非打板 → 不命中', () => {
    const hits = evalAntiSignals({ cnEmotionPhase: '高潮', isLimitUpChase: false });
    expect(hits.some((h) => h.id === 'cn_daban_hot_phase')).toBe(false);
  });

  test('tier C 或 ST → 命中 cn_tier_c', () => {
    expect(evalAntiSignals({ hardScoreTier: 'C' }).some((h) => h.id === 'cn_tier_c')).toBe(true);
    expect(evalAntiSignals({ isST: true }).some((h) => h.id === 'cn_tier_c')).toBe(true);
  });

  test('hard_score 最高五分位 → 命中', () => {
    expect(evalAntiSignals({ hardScoreTopQuintile: true }).some((h) => h.id === 'cn_hardscore_high')).toBe(true);
  });

  test('法人看多 / YouTube 原始看多 → 命中', () => {
    expect(evalAntiSignals({ brokerBullish: true }).some((h) => h.id === 'broker_bullish')).toBe(true);
    expect(evalAntiSignals({ youtubeRawBullishNoRating: true }).some((h) => h.id === 'youtube_raw_bullish')).toBe(true);
  });

  test('空 context → 不誤報', () => {
    expect(evalAntiSignals({})).toHaveLength(0);
  });
});
