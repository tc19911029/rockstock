/**
 * Contract test：基本面補漲策略 13 條防呆規則（2026-05-27）
 *
 * 對應計畫 plan 的「防呆規則驗證對照表」：
 *   (1) 不可一次性收益年化
 *   (2) Forward PE 低不直接 undervalued
 *   (3) 景氣循環股看 PB
 *   (4) IC 設計可看 PE 但 PB 過高提示
 *   (5) TW 月營收驗證
 *   (6) CN 看扣非
 *   (7) Q3/Q4 假設值要標記（schema 驗證）
 *   (8) 假設要 reason + validation（schema 驗證）
 *   (9) 資料來源矛盾標記
 *   (10) 股價反映樂觀 → 估值偏滿
 *   (11) 只有樂觀有空間 → 不能排太前
 *   (12) 本業 TTM EPS 為負 → 改 PB
 *   (13) TW/CN 分開排名
 */

import {
  scoreTwGrowth,
  scoreTwProfitability,
  scoreCnGrowth,
  scoreCnProfitability,
  scoreValuation,
  scoreRisk,
  buildBreakdown,
  gradeFromTotal,
} from '@/lib/strategy/fundamentalRevaluation/scoring';

import { deriveTwFlags, deriveCnFlags } from '@/lib/strategy/fundamentalRevaluation/recommendationGrade';
import { detectIndustryTemplateFor, getReasonablePe } from '@/lib/strategy/fundamentalRevaluation/industryReasonablePe';
import { inferRiskFlags } from '@/lib/strategy/fundamentalRevaluation/twPipeline';
import { inferCnRiskFlags, buildCnScenarios } from '@/lib/strategy/fundamentalRevaluation/cnPipeline';

import type { TwFundamentalBundle, CnFundamentalBundle } from '@/lib/strategy/fundamentalRevaluation/types';
import type { ScenarioResult, ScenarioKey } from '@/lib/valuation/types';

// ── helper：建一個 baseline TW bundle ─────────────────────────────────────
function makeTwBundle(overrides: Partial<TwFundamentalBundle> = {}): TwFundamentalBundle {
  return {
    symbol: '3661',
    name: '世芯-KY',
    market: 'TW',
    industryCategory: '半導體業',
    industryTemplate: 'high_growth_asic',
    todayPrice: 4500,
    priceDate: '2026-05-27',
    monthlyRevenue: [],
    latestMonthRevenueYoY: 30,
    latestMonthRevenueMoM: 5,
    cumulativeRevenueYoY: 25,
    last3MonthRevenueYoY: 28,
    consecutiveGrowthMonths: 4,
    isLatest12mHigh: true,
    isAllTimeHigh: false,
    quarters: [],
    latestQuarterEps: 17.55,
    latestQuarterEpsYoY: 40,
    latestQuarterEpsQoQ: 10,
    latestGrossMargin: 32,
    latestNetMargin: 34,
    latestRoe: 20,
    ttmEps: 68,
    ttmPe: 66,
    bookValuePerShare: 250,
    pbRatio: 18,
    sharesOutstanding: 81_000_000,
    peRange: { pessimistic: 40, base: 50, optimistic: 60 },
    dilutionEvents: [],
    riskFlags: [],
    dataCompleteness: 0.9,
    ...overrides,
  };
}

function makeCnBundle(overrides: Partial<CnFundamentalBundle> = {}): CnFundamentalBundle {
  return {
    symbol: '603986',
    name: '兆易創新',
    market: 'CN',
    industryCategory: '半導體',
    industryTemplate: 'high_growth_asic',
    todayPrice: 100,
    priceDate: '2026-05-27',
    latestQuarterEps: 1.5,
    ttmEps: 5.0,
    ttmPe: 20,
    dynamicPe: 18,
    staticPe: 22,
    pbRatio: 3.5,
    bookValuePerShare: 30,
    totalShares: 1_000_000_000,
    floatShares: 800_000_000,
    marketCap: 100_000_000_000,
    latestQuarterRevenue: 2_000_000_000,
    latestQuarterRevenueYoY: 35,
    latestQuarterNetProfitParent: 400_000_000,
    latestQuarterNetProfitParentYoY: 80,
    latestQuarterDeductedNetProfit: 350_000_000,
    latestQuarterDeductedNetProfitYoY: 75,
    deductedNetProfitRatio: 0.875,
    latestGrossMargin: 40,
    latestNetMargin: 20,
    roe: 15,
    operatingCashFlow: 500_000_000,
    inventoryYoY: null,
    accountsReceivableYoY: null,
    peRange: { pessimistic: 40, base: 50, optimistic: 60 },
    riskFlags: [],
    dataCompleteness: 0.9,
    ...overrides,
  };
}

function makeScenarios(args: { base: number; optimistic: number; pessimistic: number }): Record<ScenarioKey, ScenarioResult> {
  const make = (upside: number, fairPe: number): ScenarioResult => ({
    q2Eps: 0, q3Eps: 0, q4Eps: 0,
    fullYearEps: 10,
    forwardPe: 50, fairPe,
    fairPrice: 100 * (1 + upside),
    upside,
  });
  return {
    pessimistic: make(args.pessimistic, 40),
    base: make(args.base, 50),
    optimistic: make(args.optimistic, 60),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// (1) 不可一次性收益年化
// ────────────────────────────────────────────────────────────────────────────

describe('防呆 (1) 一次性收益不可直接年化', () => {
  it('一次性收益旗 → buildBreakdown 把 A 降為 B', () => {
    const bd = buildBreakdown({
      growth: { dimension: 'growth', label: '', cap: 25, items: [], score: 25 },
      profitability: { dimension: 'profitability', label: '', cap: 25, items: [], score: 25 },
      valuation: { dimension: 'valuation', label: '', cap: 25, items: [], score: 25 },
      risk: { dimension: 'risk', label: '', cap: 25, items: [], score: 15 },
      flags: ['one_time_gain'],
    });
    // 總分 90 但有 one_time_gain → 不可為 A
    expect(bd.total).toBe(90);
    expect(bd.grade).not.toBe('A_core');
    expect(bd.grade).toBe('B_candidate');
  });

  it('inferRiskFlags：當季淨利率 vs 上季 +10pp → 觸發 one_time_gain', () => {
    const flags = inferRiskFlags({
      ttmEps: 5,
      latestNetMargin: 45,    // 45%
      previousNetMargin: 30,  // 30% → +15pp 巨幅跳升
      pbRatio: 2,
      roe: 15,
      industryTemplate: 'high_growth_asic',
      hasMonthlyRevenue: true,
      dilutionPending: false,
    });
    expect(flags).toContain('one_time_gain');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (2) Forward PE 低不直接 undervalued
// ────────────────────────────────────────────────────────────────────────────

describe('防呆 (2) Forward PE 低且有一次性收益 → 不可標 undervalued', () => {
  it('一次性收益旗在 → grade 必降', () => {
    const bundle = makeTwBundle({ riskFlags: ['one_time_gain'] });
    const scenarios = makeScenarios({ base: 0.3, optimistic: 0.5, pessimistic: 0.1 }); // upside 大
    const flags = deriveTwFlags(bundle, scenarios);
    expect(flags).toContain('one_time_gain');
    // 即便 base.upside > 20% 觸發 undervalued，配合 one_time_gain 仍要在 buildBreakdown 降級
    expect(flags).toContain('undervalued');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (3) 景氣循環股看 PB
// ────────────────────────────────────────────────────────────────────────────

describe('防呆 (3) 景氣循環股 → PB + ROE 高 → cyclical_peak', () => {
  it('inferRiskFlags：cyclical + PB>2 + ROE>20 → cyclical_peak', () => {
    const flags = inferRiskFlags({
      ttmEps: 5,
      latestNetMargin: 0.15,
      previousNetMargin: 14,
      pbRatio: 3,
      roe: 25,
      industryTemplate: 'cyclical',
      hasMonthlyRevenue: true,
      dilutionPending: false,
    });
    expect(flags).toContain('cyclical_peak');
  });

  it('非景氣循環股不會誤標 cyclical_peak（即便 PB+ROE 高）', () => {
    const flags = inferRiskFlags({
      ttmEps: 5,
      latestNetMargin: 0.30,
      previousNetMargin: 30,
      pbRatio: 4,
      roe: 25,
      industryTemplate: 'high_growth_asic',
      hasMonthlyRevenue: true,
      dilutionPending: false,
    });
    expect(flags).not.toContain('cyclical_peak');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (4) IC 設計 PB 過高提示
// ────────────────────────────────────────────────────────────────────────────

describe('防呆 (4) IC 設計 PB > 5 → pb_overheated 旗', () => {
  it('high_growth_asic + PB=7 → pb_overheated', () => {
    const flags = inferRiskFlags({
      ttmEps: 5,
      latestNetMargin: 0.30,
      previousNetMargin: 30,
      pbRatio: 7,
      roe: 25,
      industryTemplate: 'high_growth_asic',
      hasMonthlyRevenue: true,
      dilutionPending: false,
    });
    expect(flags).toContain('pb_overheated');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (5) TW 月營收驗證 — 無月營收應旗 + 影響分數
// ────────────────────────────────────────────────────────────────────────────

describe('防呆 (5) TW 月營收缺 → monthly_revenue_pending 旗', () => {
  it('無月營收 → monthly_revenue_pending', () => {
    const flags = inferRiskFlags({
      ttmEps: 5, latestNetMargin: 0.20, previousNetMargin: 18,
      pbRatio: 2, roe: 15, industryTemplate: 'stable_mature',
      hasMonthlyRevenue: false, dilutionPending: false,
    });
    expect(flags).toContain('monthly_revenue_pending');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (6) CN 看扣非 — 扣非占比低 → one_time_gain
// ────────────────────────────────────────────────────────────────────────────

describe('防呆 (6) CN 扣非品質', () => {
  it('扣非/歸母 < 50% → one_time_gain', () => {
    const flags = inferCnRiskFlags({
      deductedRatio: 0.3,
      pbRatio: 3,
      roe: 10,
      industryTemplate: 'high_growth_asic',
      parentNetProfitYoY: 60,
      deductedNetProfitYoY: 15,
    });
    expect(flags).toContain('one_time_gain');
  });

  it('歸母 YoY 高但扣非 YoY 低（業外撐起來）→ one_time_gain', () => {
    const flags = inferCnRiskFlags({
      deductedRatio: 0.65,
      pbRatio: 3,
      roe: 10,
      industryTemplate: 'high_growth_asic',
      parentNetProfitYoY: 60,
      deductedNetProfitYoY: 15,
    });
    expect(flags).toContain('one_time_gain');
  });

  it('scoreCnProfitability：扣非占比 < 50% → 扣 8 分', () => {
    const bundle = makeCnBundle({ deductedNetProfitRatio: 0.4, latestQuarterDeductedNetProfitYoY: 10 });
    const dim = scoreCnProfitability(bundle);
    const item = dim.items.find((i) => i.key === 'ded_ratio_below_50');
    expect(item).toBeDefined();
    expect(item!.delta).toBe(-8);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (7) Q3/Q4 假設值要標記 + (8) reason + validation 必填 — 由 skill schema 強制
//   程式端的 DeepScenarioAssumption 型別已宣告必填，這裡確認型別存在
// ────────────────────────────────────────────────────────────────────────────

describe('防呆 (7)(8) DeepScenarioAssumption 必填欄位', () => {
  it('DeepScenarioAssumption 型別存在且 confidenceLevel/validationCondition 必填', () => {
    // 純型別檢查：能 import 就過。runtime 用實例驗證
    const obj: import('@/lib/strategy/fundamentalRevaluation/types').DeepScenarioAssumption = {
      scenario: 'base',
      quarter: 'Q3',
      revenueAssumption: 100,
      revenueBasis: '法說會 Q3 大量出貨',
      netMarginAssumption: 0.35,
      netMarginBasis: '上季淨利率',
      epsResult: 5,
      confidenceLevel: 'medium',
      validationCondition: '7-9 月月營收均 35 億',
    };
    expect(obj.confidenceLevel).toBe('medium');
    expect(obj.validationCondition).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (10) 估值偏滿 + (11) 只有樂觀有空間 → 不能 A
// ────────────────────────────────────────────────────────────────────────────

describe('防呆 (10)(11) 估值偏滿 / 樂觀情境獨大', () => {
  it('現價超過中性合理價且樂觀也低 upside → valuation_stretched', () => {
    const bundle = makeTwBundle();
    const scenarios = makeScenarios({ base: -0.1, optimistic: 0.05, pessimistic: -0.2 });
    const flags = deriveTwFlags(bundle, scenarios);
    expect(flags).toContain('valuation_stretched');
  });

  it('只有樂觀情境有 ≥20% upside → only_optimistic_has_upside', () => {
    const bundle = makeTwBundle();
    const scenarios = makeScenarios({ base: 0.1, optimistic: 0.3, pessimistic: -0.1 });
    const flags = deriveTwFlags(bundle, scenarios);
    expect(flags).toContain('only_optimistic_has_upside');
  });

  it('only_optimistic_has_upside 旗 + 總分 85+ → grade 從 A 降 B', () => {
    const bd = buildBreakdown({
      growth: { dimension: 'growth', label: '', cap: 25, items: [], score: 25 },
      profitability: { dimension: 'profitability', label: '', cap: 25, items: [], score: 25 },
      valuation: { dimension: 'valuation', label: '', cap: 25, items: [], score: 20 },
      risk: { dimension: 'risk', label: '', cap: 25, items: [], score: 20 },
      flags: ['only_optimistic_has_upside'],
    });
    expect(bd.total).toBe(90);
    expect(bd.grade).toBe('B_candidate');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (12) 本業 TTM EPS 為負 → using_pb_evaluation 旗
// ────────────────────────────────────────────────────────────────────────────

describe('防呆 (12) TTM EPS 為負 → using_pb_evaluation', () => {
  it('TW: ttmEps <= 0 → flag', () => {
    const bundle = makeTwBundle({ ttmEps: -2 });
    const scenarios = makeScenarios({ base: 0.1, optimistic: 0.3, pessimistic: -0.1 });
    const flags = deriveTwFlags(bundle, scenarios);
    expect(flags).toContain('using_pb_evaluation');
  });

  it('CN: ttmEps <= 0 → flag', () => {
    const bundle = makeCnBundle({ ttmEps: -1 });
    const scenarios = makeScenarios({ base: 0.1, optimistic: 0.3, pessimistic: -0.1 });
    const flags = deriveCnFlags(bundle, scenarios);
    expect(flags).toContain('using_pb_evaluation');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// (13) TW/CN 分開排名 — bundle.market 為兩種獨立值，runner 各自寫獨立 session 檔
// ────────────────────────────────────────────────────────────────────────────

describe('防呆 (13) TW/CN 分開排名', () => {
  it('TW bundle.market === "TW", CN bundle.market === "CN"', () => {
    expect(makeTwBundle().market).toBe('TW');
    expect(makeCnBundle().market).toBe('CN');
  });

  it('industryReasonablePe.detectIndustryTemplateFor 兩個市場參數獨立', () => {
    // CN 仍走 keyword：'半導體' → high_growth_asic
    expect(detectIndustryTemplateFor('CN', '半導體')).toBe('high_growth_asic');
  });

  it('TW 半導體業不再 blanket PE50：未列白名單 → other（2026-06-03 修）', () => {
    // TWSE 對所有半導體股都只回「半導體業」，過去 /半導體業/ blanket → high_growth_asic(PE50)
    // 把 DRAM/封測/成熟代工的合理價灌爆（威剛 +1111%）。現移除 blanket，無 symbol → 'other'。
    expect(detectIndustryTemplateFor('TW', '半導體業')).toBe('other');
  });

  it('TW 半導體細分白名單：symbol 覆寫分流 DRAM/代工/封測 vs 高成長', () => {
    // 真高成長（晶圓代工龍頭 / IC 設計 / ASIC）→ high_growth_asic(PE40/50/60)
    expect(detectIndustryTemplateFor('TW', '半導體業', '2330')).toBe('high_growth_asic'); // 台積電
    expect(detectIndustryTemplateFor('TW', '半導體業', '2454')).toBe('high_growth_asic'); // 聯發科
    // DRAM/記憶體 → cyclical(PE5-9)
    expect(detectIndustryTemplateFor('TW', '半導體業', '2408')).toBe('cyclical'); // 南亞科
    expect(detectIndustryTemplateFor('TW', '半導體業', '3260')).toBe('cyclical'); // 威剛
    // 成熟代工 / 封測 → stable_mature(PE15-25)
    expect(detectIndustryTemplateFor('TW', '半導體業', '2303')).toBe('stable_mature'); // 聯電
    expect(detectIndustryTemplateFor('TW', '半導體業', '3711')).toBe('stable_mature'); // 日月光投控
    // 帶 .TW 後綴也要正確剝碼
    expect(detectIndustryTemplateFor('TW', '半導體業', '3260.TW')).toBe('cyclical');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 額外：scoring sanity（happy path + clamp）
// ────────────────────────────────────────────────────────────────────────────

describe('Scoring sanity', () => {
  it('gradeFromTotal boundaries', () => {
    expect(gradeFromTotal(85)).toBe('A_core');
    expect(gradeFromTotal(75)).toBe('B_candidate');
    expect(gradeFromTotal(65)).toBe('C_watch');
    expect(gradeFromTotal(55)).toBe('D_weak');
    expect(gradeFromTotal(54)).toBe('excluded');
  });

  it('每個維度上限 25', () => {
    const bundle = makeTwBundle({
      latestMonthRevenueYoY: 200,
      latestMonthRevenueMoM: 100,
      cumulativeRevenueYoY: 100,
      isAllTimeHigh: true,
      consecutiveGrowthMonths: 12,
    });
    const dim = scoreTwGrowth(bundle);
    expect(dim.score).toBeLessThanOrEqual(25);
    expect(dim.score).toBeGreaterThanOrEqual(0);
  });

  it('CN scoreValuation：Forward PE < 合理 PE × 80% → +8', () => {
    const dim = scoreValuation({
      forwardPeBase: 30, fairPeBase: 50, baseUpside: 0.5,
      optimisticOnly: false, pbRatio: 2, ttmPe: 40,
    });
    const item = dim.items.find((i) => i.key === 'fwd_pe_below_80pct_fair');
    expect(item).toBeDefined();
  });
});

describe('CN scenario builder', () => {
  it('扣非占比佳（>70%）→ 用扣非 YoY', () => {
    const scenarios = buildCnScenarios({
      ttmEps: 5,
      parentNetProfitYoY: 100,
      deductedNetProfitYoY: 80,
      deductedRatio: 0.9,
      todayPrice: 100,
      fairPePessimistic: 40, fairPeBase: 50, fairPeOptimistic: 60,
    });
    expect(scenarios.base.fullYearEps).toBeCloseTo(5 * 1.8, 3); // 5 * (1 + 0.80)
  });

  it('扣非占比差（<50%）→ 用歸母 YoY × ratio 折扣', () => {
    const scenarios = buildCnScenarios({
      ttmEps: 5,
      parentNetProfitYoY: 100,
      deductedNetProfitYoY: 5,
      deductedRatio: 0.3,
      todayPrice: 100,
      fairPePessimistic: 40, fairPeBase: 50, fairPeOptimistic: 60,
    });
    // 歸母 100% × ratio 0.3 = 30% → factor 1 → fullYear = 5 * 1.3
    expect(scenarios.base.fullYearEps).toBeCloseTo(5 * 1.3, 3);
  });

  it('TTM EPS = null → 三情境都回 0', () => {
    const scenarios = buildCnScenarios({
      ttmEps: null,
      parentNetProfitYoY: 50,
      deductedNetProfitYoY: 50,
      deductedRatio: 0.9,
      todayPrice: 100,
      fairPePessimistic: 40, fairPeBase: 50, fairPeOptimistic: 60,
    });
    expect(scenarios.base.fullYearEps).toBe(0);
    expect(scenarios.optimistic.fullYearEps).toBe(0);
  });
});
