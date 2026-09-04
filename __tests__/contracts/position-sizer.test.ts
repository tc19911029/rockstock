/**
 * Contract test：部位大小引擎 4 模式 + risk guards
 *
 * 守的規則：
 *   - 4 模式各自純函式可推
 *   - kelly 樣本 < 30 強制 fallback 到 fixedFraction（避免小樣本爆破）
 *   - perPositionMaxPct 永遠是硬上限
 *   - perIndustryMaxPct 考慮既有部位
 *   - perTrackMaxPct 考慮既有部位
 *   - MDD 紅燈時 raw × 0.5
 *   - lot size 對齊（TW 1000 / CN 100）
 *   - letterWeights 必須與 backtest data 一致（不可拍腦袋）
 *   - DEFAULT_SIZING_CONFIG schemaVersion = 1
 *   - 紅燈訊息含「禁止放寬選股」字樣（規則 #5）
 */

import {
  suggestPositionSize,
  applyRiskGuards,
  regimeExposureCap,
  DEFAULT_SIZING_CONFIG,
  DEFAULT_LETTER_WEIGHTS,
  DEFAULT_RESONANCE_BONUS,
  SIZING_SCHEMA_VERSION,
  type SizingConfig,
  type SizingRequest,
  type LetterStats,
} from '@/lib/portfolio/positionSizer';

function makeRequest(o: Partial<SizingRequest> = {}): SizingRequest {
  return {
    totalCapital: 76_000_000,
    candidatePrice: 1100,
    market: 'TW',
    letter: 'N',
    existingHoldings: [],
    ...o,
  };
}

function configWithMode(mode: SizingConfig['mode'], override: Partial<SizingConfig> = {}): SizingConfig {
  return { ...DEFAULT_SIZING_CONFIG, mode, ...override };
}

describe('fixedFraction mode', () => {
  test('totalCapital × fixedFractionPct（預設 10%）', () => {
    const r = suggestPositionSize(makeRequest(), configWithMode('fixedFraction'));
    expect(r.mode).toBe('fixedFraction');
    expect(r.rawCapital).toBeCloseTo(76_000_000 * 0.10, 0);
    // perPositionMax 15% 未觸（10% < 15%），cappedCapital 同 raw
    expect(r.cappedCapital).toBeCloseTo(7_600_000, 0);
  });

  test('lot size 對齊（TW 1000）', () => {
    const r = suggestPositionSize(makeRequest({ candidatePrice: 100 }), configWithMode('fixedFraction'));
    // raw 7.6M / 100 = 76000 股 = 76 張
    expect(r.lots).toBe(76);
    expect(r.shares).toBe(76000);
  });

  test('資金不足買 1 lot → 0 股 + warning', () => {
    const r = suggestPositionSize(
      makeRequest({ totalCapital: 1_000_000, candidatePrice: 5000 }),
      configWithMode('fixedFraction'),
    );
    // 10% × 1M = 100K，無法買 1 lot (5000 × 1000 = 5M)
    expect(r.shares).toBe(0);
    expect(r.warnings.some(w => w.includes('不足以買 1 lot'))).toBe(true);
  });
});

describe('kelly mode', () => {
  const letterStats: Record<string, LetterStats> = {
    N: { winRate: 56.4, maxGainMedian: 12.25, maxLossMedian: -5.36, samples: 350 },
    F: { winRate: 46.2, maxGainMedian: 9.21, maxLossMedian: -6.88, samples: 312 },
    D: { winRate: 60, maxGainMedian: 10, maxLossMedian: -5, samples: 10 },  // 樣本不足
  };

  test('N letter Kelly 計算', () => {
    const r = suggestPositionSize(
      makeRequest({ letter: 'N', letterStatsByLetter: letterStats }),
      configWithMode('kelly'),
    );
    // p=0.564, b=12.25/5.36=2.286, kelly=(2.286×0.564-0.436)/2.286 ≈ 0.373
    // halfKelly = 0.187, totalCapital × 0.187 ≈ 14.2M
    // 但 perPositionMax 15% = 11.4M → 觸發 cap
    expect(r.kellyFraction).toBeCloseTo(0.187, 2);
    expect(r.appliedGuards).toContain('perPositionMax');
    expect(r.cappedCapital).toBeCloseTo(76_000_000 * 0.15, 0);
  });

  test('樣本 < 30 → fallback to fixedFraction', () => {
    const r = suggestPositionSize(
      makeRequest({ letter: 'D', letterStatsByLetter: letterStats }),
      configWithMode('kelly'),
    );
    expect(r.reasoning).toContain('fallback');
    expect(r.reasoning).toContain('< 30');
    // 同 fixedFraction 10% × 76M = 7.6M
    expect(r.rawCapital).toBeCloseTo(7_600_000, 0);
  });

  test('無 letter → fallback', () => {
    const r = suggestPositionSize(
      makeRequest({ letter: undefined, letterStatsByLetter: letterStats }),
      configWithMode('kelly'),
    );
    expect(r.reasoning).toContain('fallback');
  });

  test('Kelly fraction 可調（quarterKelly）', () => {
    const r = suggestPositionSize(
      makeRequest({ letter: 'N', letterStatsByLetter: letterStats }),
      configWithMode('kelly', { kellyFraction: 0.25 }),
    );
    // 0.373 × 0.25 = 0.093
    expect(r.kellyFraction).toBeCloseTo(0.093, 2);
  });
});

describe('letterAware mode', () => {
  test('N 字母 weight 0.76', () => {
    const r = suggestPositionSize(
      makeRequest({ letter: 'N' }),
      configWithMode('letterAware'),
    );
    expect(r.letterMultiplier).toBe(0.76);
    expect(r.resonanceMultiplier).toBe(1.0);
    // 10% × 0.76 = 7.6%, raw = 5.776M
    expect(r.rawCapital).toBeCloseTo(76_000_000 * 0.10 * 0.76, 0);
  });

  test('N+Q 共振 → multiplier 1.25', () => {
    const r = suggestPositionSize(
      makeRequest({ letter: 'N', matchedMethods: ['N', 'Q'] }),
      configWithMode('letterAware'),
    );
    expect(r.resonanceMultiplier).toBe(1.25);
    // 10% × 0.76 × 1.25 = 9.5%
    expect(r.rawCapital).toBeCloseTo(76_000_000 * 0.10 * 0.76 * 1.25, 0);
  });

  test('共振 key 順序不影響（J+B vs B+J）', () => {
    const a = suggestPositionSize(
      makeRequest({ letter: 'B', matchedMethods: ['B', 'J'] }),
      configWithMode('letterAware'),
    );
    const b = suggestPositionSize(
      makeRequest({ letter: 'B', matchedMethods: ['J', 'B'] }),
      configWithMode('letterAware'),
    );
    expect(a.resonanceMultiplier).toBe(b.resonanceMultiplier);
    expect(a.resonanceMultiplier).toBe(1.30);
  });

  test('未知字母 → 預設 weight 0.5', () => {
    const r = suggestPositionSize(
      makeRequest({ letter: 'Z' }),
      configWithMode('letterAware'),
    );
    expect(r.letterMultiplier).toBe(0.5);
  });
});

describe('riskParity mode', () => {
  test('每筆風險 1% × totalCapital / stopLoss 距離', () => {
    const r = suggestPositionSize(
      makeRequest({ candidatePrice: 1000, candidateStopLoss: 930 }),  // 7% distance
      configWithMode('riskParity'),
    );
    expect(r.stopLossDistancePct).toBeCloseTo(0.07, 3);
    // riskAmount = 76M × 1% = 760K；position = 760K / 0.07 = 10.857M
    // 但 perPositionMax 15% = 11.4M → 未觸（10.857 < 11.4）
    expect(r.rawCapital).toBeCloseTo(10_857_143, 0);
  });

  test('無 stopLoss → fallback', () => {
    const r = suggestPositionSize(
      makeRequest({ candidateStopLoss: undefined }),
      configWithMode('riskParity'),
    );
    expect(r.reasoning).toContain('fallback');
  });

  test('stopLoss ≥ entry → fallback（避免除負）', () => {
    const r = suggestPositionSize(
      makeRequest({ candidatePrice: 1000, candidateStopLoss: 1050 }),
      configWithMode('riskParity'),
    );
    expect(r.reasoning).toContain('fallback');
  });
});

describe('riskGuards', () => {
  test('perPositionMax 硬上限', () => {
    const r = applyRiskGuards({
      rawCapital: 100_000_000,  // 巨大
      req: makeRequest(),
      config: DEFAULT_SIZING_CONFIG,
    });
    expect(r.cappedCapital).toBeLessThanOrEqual(76_000_000 * 0.15);
    expect(r.appliedGuards).toContain('perPositionMax');
  });

  test('perIndustryMax 考慮既有部位', () => {
    const r = applyRiskGuards({
      rawCapital: 10_000_000,
      req: makeRequest({
        industry: '半導體 - DRAM',
        existingHoldings: [
          { symbol: 'X.TW', industry: '半導體 - DRAM', currentValue: 20_000_000 },
        ],
      }),
      config: DEFAULT_SIZING_CONFIG,
    });
    // 既有 20M，上限 76M × 0.3 = 22.8M，剩 2.8M
    expect(r.cappedCapital).toBeCloseTo(2_800_000, 0);
    expect(r.appliedGuards).toContain('perIndustryMax');
  });

  test('perIndustryMax prefix match：「半導體 - DRAM」配「半導體 - 晶圓代工」（同 prefix）', () => {
    const r = applyRiskGuards({
      rawCapital: 10_000_000,
      req: makeRequest({
        industry: '半導體 - 晶圓代工',
        existingHoldings: [
          { symbol: 'X.TW', industry: '半導體 - DRAM', currentValue: 15_000_000 },
          { symbol: 'Y.TW', industry: '半導體 - IC 設計', currentValue: 10_000_000 },
        ],
      }),
      config: DEFAULT_SIZING_CONFIG,
    });
    // 既有同 prefix「半導體」= 25M；上限 22.8M → 已 over，剩 0
    expect(r.cappedCapital).toBe(0);
    expect(r.appliedGuards).toContain('perIndustryMax');
  });

  test('perIndustryMax 不同 prefix 不算同類', () => {
    const r = applyRiskGuards({
      rawCapital: 5_000_000,
      req: makeRequest({
        industry: '金融 - 銀行',
        existingHoldings: [
          { symbol: 'X.TW', industry: '半導體 - DRAM', currentValue: 30_000_000 },
        ],
      }),
      config: DEFAULT_SIZING_CONFIG,
    });
    // 「金融」≠「半導體」prefix，industry guard 不觸發
    expect(r.appliedGuards).not.toContain('perIndustryMax');
  });

  test('perTrackMax 考慮既有部位', () => {
    const r = applyRiskGuards({
      rawCapital: 10_000_000,
      req: makeRequest({
        track: 'bullish',
        existingHoldings: [
          { symbol: 'X.TW', track: 'bullish', currentValue: 40_000_000 },
        ],
      }),
      config: DEFAULT_SIZING_CONFIG,
    });
    // 既有 40M，上限 76M × 0.6 = 45.6M，剩 5.6M
    expect(r.cappedCapital).toBeCloseTo(5_600_000, 0);
    expect(r.appliedGuards).toContain('perTrackMax');
  });

  test('MDD 紅燈觸發 × 0.5', () => {
    const r = applyRiskGuards({
      rawCapital: 7_600_000,
      req: makeRequest({ currentPortfolioMddPct: 0.12 }),  // 12% > 10% 紅燈
      config: DEFAULT_SIZING_CONFIG,
    });
    expect(r.appliedGuards).toContain('mddTrigger');
    // 7.6M × 0.5 = 3.8M
    expect(r.cappedCapital).toBeCloseTo(3_800_000, 0);
    // 警示必含「禁止放寬」字樣（規則 #5）
    expect(r.warnings.join(' ')).toContain('禁止放寬選股');
  });

  test('MDD 未過紅燈不觸發', () => {
    const r = applyRiskGuards({
      rawCapital: 7_600_000,
      req: makeRequest({ currentPortfolioMddPct: 0.05 }),
      config: DEFAULT_SIZING_CONFIG,
    });
    expect(r.appliedGuards).not.toContain('mddTrigger');
  });

  test('多 guard 累加：perPosition + perIndustry', () => {
    const r = applyRiskGuards({
      rawCapital: 100_000_000,
      req: makeRequest({
        industry: '半導體',
        existingHoldings: [
          { symbol: 'X.TW', industry: '半導體', currentValue: 20_000_000 },
        ],
      }),
      config: DEFAULT_SIZING_CONFIG,
    });
    // perPositionMax → 11.4M；perIndustryMax 剩 2.8M（更緊）
    expect(r.cappedCapital).toBeCloseTo(2_800_000, 0);
    expect(r.appliedGuards).toEqual(['perPositionMax', 'perIndustryMax']);
  });
});

describe('default config invariants', () => {
  test('SIZING_SCHEMA_VERSION = 1', () => {
    expect(SIZING_SCHEMA_VERSION).toBe(1);
  });

  test('letterWeights 範圍 [0.3, 1.0]', () => {
    for (const w of Object.values(DEFAULT_LETTER_WEIGHTS)) {
      expect(w).toBeGreaterThanOrEqual(0.3);
      expect(w).toBeLessThanOrEqual(1.0);
    }
  });

  test('letterWeights 必須含 backtest 主力字母 N/B/Q/J/M', () => {
    expect(DEFAULT_LETTER_WEIGHTS.N).toBeDefined();
    expect(DEFAULT_LETTER_WEIGHTS.B).toBeDefined();
    expect(DEFAULT_LETTER_WEIGHTS.Q).toBeDefined();
    expect(DEFAULT_LETTER_WEIGHTS.J).toBeDefined();
    expect(DEFAULT_LETTER_WEIGHTS.M).toBeDefined();
  });

  test('letterWeights 排序：J 最強 > N > M > B > Q > F 最弱（從 backtest）', () => {
    expect(DEFAULT_LETTER_WEIGHTS.J).toBeGreaterThanOrEqual(DEFAULT_LETTER_WEIGHTS.N);
    expect(DEFAULT_LETTER_WEIGHTS.N).toBeGreaterThanOrEqual(DEFAULT_LETTER_WEIGHTS.B);
    expect(DEFAULT_LETTER_WEIGHTS.B).toBeGreaterThanOrEqual(DEFAULT_LETTER_WEIGHTS.F);
    expect(DEFAULT_LETTER_WEIGHTS.F).toBeLessThanOrEqual(0.5);  // 反轉軌弱字母明確降權
  });

  test('resonanceBonus 範圍 [1.0, 1.5]', () => {
    for (const v of Object.values(DEFAULT_RESONANCE_BONUS)) {
      expect(v).toBeGreaterThanOrEqual(1.0);
      expect(v).toBeLessThanOrEqual(1.5);
    }
  });

  test('DEFAULT_SIZING_CONFIG schemaVersion = 1', () => {
    expect(DEFAULT_SIZING_CONFIG.schemaVersion).toBe(1);
  });

  test('預設 perPositionMax 15%、perIndustryMax 30%、perTrackMax 60%、portfolioMdd 10%', () => {
    expect(DEFAULT_SIZING_CONFIG.perPositionMaxPct).toBe(0.15);
    expect(DEFAULT_SIZING_CONFIG.perIndustryMaxPct).toBe(0.30);
    expect(DEFAULT_SIZING_CONFIG.perTrackMaxPct).toBe(0.60);
    expect(DEFAULT_SIZING_CONFIG.portfolioMddTriggerPct).toBe(0.10);
  });

  test('預設 kellyFraction = 0.5（半 Kelly，樣本不足時不爆破）', () => {
    expect(DEFAULT_SIZING_CONFIG.kellyFraction).toBe(0.5);
  });
});

describe('sizer-no-self-invented-factors（letterWeights 來源驗證）', () => {
  // 守 letterWeights 不可拍腦袋：每個字母的 weight 必須能從 backtest data 反推。
  // 這份測試硬編 backtest 來源數值，若 backtest 重跑後 weight 沒更新 → fail。
  test('N letterWeight = 0.76 對應半 Kelly normalize（backtest 2026-05-21）', () => {
    // N: win 56.4%, gain 12.25, loss 6.88 → kelly 0.373, halfK 0.187
    // J: halfK 0.283（max）
    // weight = 0.3 + 0.7 × (0.187 / 0.283) = 0.3 + 0.462 = 0.762
    expect(DEFAULT_LETTER_WEIGHTS.N).toBeCloseTo(0.76, 1);
  });

  test('F letterWeight 接近底（反轉軌最弱）', () => {
    expect(DEFAULT_LETTER_WEIGHTS.F).toBeLessThanOrEqual(0.4);
  });

  test('J letterWeight = 1.0（backtest 半 Kelly 最高）', () => {
    expect(DEFAULT_LETTER_WEIGHTS.J).toBe(1.0);
  });
});

// 書本 CH5-06 + 直播 2026-07-01 QA#15（2026-07-04 體檢補）：大盤 regime → 總投入成數上限
describe('totalInvestCapPct（大盤 regime 總投入上限）', () => {
  test('缺值 → 不啟用（向下相容）', () => {
    const g = applyRiskGuards({
      rawCapital: 7_600_000,
      req: makeRequest(),
      config: DEFAULT_SIZING_CONFIG,
    });
    expect(g.appliedGuards).not.toContain('totalExposureCap');
  });

  test('空頭 3 成：既有部位已占 25% → 本筆只剩 5% 額度', () => {
    const g = applyRiskGuards({
      rawCapital: 7_600_000, // raw 10%
      req: makeRequest({
        totalInvestCapPct: 0.3,
        existingHoldings: [{ symbol: 'X', currentValue: 19_000_000 }], // 25% of 76M
      }),
      config: DEFAULT_SIZING_CONFIG,
    });
    expect(g.appliedGuards).toContain('totalExposureCap');
    expect(g.cappedCapital).toBeCloseTo(76_000_000 * 0.30 - 19_000_000, 0); // 3,800,000 = 5%
  });

  test('既有部位已超過上限 → 本筆額度 0', () => {
    const g = applyRiskGuards({
      rawCapital: 7_600_000,
      req: makeRequest({
        totalInvestCapPct: 0.3,
        existingHoldings: [{ symbol: 'X', currentValue: 30_000_000 }], // ~39%
      }),
      config: DEFAULT_SIZING_CONFIG,
    });
    expect(g.cappedCapital).toBe(0);
  });

  test('regimeExposureCap 梯度：空頭0.3 / 盤整或近高0.5 / 強多頭0.8', () => {
    expect(regimeExposureCap('bear', false)).toBe(0.3);
    expect(regimeExposureCap('normal', false)).toBe(0.5);
    expect(regimeExposureCap('strong_bull', true)).toBe(0.5);  // 近歷史高檔壓五成（CH5-06 優先）
    expect(regimeExposureCap('strong_bull', false)).toBe(0.8);
  });
});
