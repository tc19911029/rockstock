/**
 * CN 基本面補漲策略 Pipeline（Phase 1 程式端，2026-05-27）
 *
 * 流程：
 *   1. 硬條件過濾
 *   2. 並行取資料（EastMoneyFundamentals push2 估值 + EastMoneyFinancialDetail f10 季報）
 *   3. 推導：扣非淨利占比、ROE 改善、cash flow / 存貨 / 應收（後三項暫無資料源，留 V2）
 *   4. 推估 Forward EPS（以季報為基準）
 *   5. 評分（4 × 25）
 *   6. 輸出 FundamentalRevaluationResult
 *
 * 與 TW 版差異：
 *   - 無月營收 → 不能提前推 EPS，只能用季報延伸
 *   - 用「扣非淨利 / 歸母淨利」做為「業外占比」proxy
 *   - 三情境用「最近 4 季 EPS 加總 × 成長率」推估
 */

import {
  getEastMoneyFundamentals,
} from '@/lib/datasource/EastMoneyFundamentals';

import {
  getEastMoneyFinancialDetail,
  deductedNetProfitRatio,
  latestQuarter,
  type EastMoneyFinancialDetail,
} from '@/lib/datasource/EastMoneyFinancialDetail';

import { detectIndustryTemplateFor, getReasonablePe } from './industryReasonablePe';
import { computeTTMPe } from '@/lib/valuation/ttm';

import type {
  QuarterRow,
  ScenarioKey,
  ScenarioResult,
  RiskFlag,
} from '@/lib/valuation/types';

import {
  scoreCnGrowth,
  scoreCnProfitability,
  scoreValuation,
  scoreRisk,
  buildBreakdown,
} from './scoring';

import { deriveCnFlags } from './recommendationGrade';

import type {
  CnFundamentalBundle,
  FundamentalRevaluationResult,
  HardFilterResult,
} from './types';

const STRATEGY_VERSION = 'cn-fundamental-revaluation@1.0.0';

// ────────────────────────────────────────────────────────────────────────────
// 1. 硬條件
// ────────────────────────────────────────────────────────────────────────────

export interface CnHardFilterInput {
  symbol: string;
  todayPrice: number | null;
  averageTurnover20d?: number | null;
}

export function applyCnHardFilter(inp: CnHardFilterInput): HardFilterResult {
  if (!inp.symbol) return { passed: false, failedReason: 'no_symbol' };
  if (!inp.todayPrice || inp.todayPrice <= 0) return { passed: false, failedReason: 'no_price' };
  if (inp.todayPrice < 3) return { passed: false, failedReason: 'price_too_low' };
  // 成交額過低（< 5000 萬 RMB 日均）不在補漲範圍
  if (inp.averageTurnover20d != null && inp.averageTurnover20d < 50_000_000) {
    return { passed: false, failedReason: 'turnover_too_low' };
  }
  return { passed: true };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 推 EPS 三情境（陸股版）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 陸股無月營收，只能用「最近一季淨利 × 4」做基準，再套三情境 YoY。
 *
 * 計算方式：
 *   ttmEps = 過去 4 季 EPS 加總（從 detail.quarters 取）
 *   pessimistic: 全年 EPS = ttmEps × (1 + last YoY × 0.5)
 *   base:        全年 EPS = ttmEps × (1 + last YoY × 1.0)
 *   optimistic:  全年 EPS = ttmEps × (1 + last YoY × 1.5)
 *
 * 對「扣非品質佳」(ratio > 0.7) 的股票，YoY 採用扣非 YoY；否則打折。
 */
export function buildCnScenarios(args: {
  ttmEps: number | null;
  parentNetProfitYoY: number | null;
  deductedNetProfitYoY: number | null;
  deductedRatio: number | null;
  todayPrice: number;
  fairPePessimistic: number;
  fairPeBase: number;
  fairPeOptimistic: number;
}): Record<ScenarioKey, ScenarioResult> {
  const { ttmEps, todayPrice, fairPePessimistic, fairPeBase, fairPeOptimistic } = args;

  if (ttmEps == null || ttmEps <= 0) {
    const empty = (fairPe: number): ScenarioResult => ({
      q2Eps: 0, q3Eps: 0, q4Eps: 0, fullYearEps: 0,
      forwardPe: Number.POSITIVE_INFINITY,
      fairPe, fairPrice: 0, upside: 0,
    });
    return {
      pessimistic: empty(fairPePessimistic),
      base: empty(fairPeBase),
      optimistic: empty(fairPeOptimistic),
    };
  }

  // 選 YoY 基準
  const ratio = args.deductedRatio ?? 1;
  let yoyPct: number | null = null;
  if (ratio > 0.7 && args.deductedNetProfitYoY != null) {
    yoyPct = args.deductedNetProfitYoY;
  } else if (args.parentNetProfitYoY != null) {
    yoyPct = args.parentNetProfitYoY * Math.max(ratio, 0.3); // 扣非占比低 → 折扣 YoY
  }

  const yoy = (yoyPct ?? 0) / 100;
  const make = (factor: number, fairPe: number): ScenarioResult => {
    const fullYear = ttmEps * (1 + yoy * factor);
    const forwardPe = fullYear > 0 ? todayPrice / fullYear : Number.POSITIVE_INFINITY;
    const fairPrice = fullYear > 0 ? fullYear * fairPe : 0;
    const upside = todayPrice > 0 && fairPrice > 0 ? fairPrice / todayPrice - 1 : 0;
    return {
      q2Eps: 0, q3Eps: 0, q4Eps: 0,
      fullYearEps: fullYear,
      forwardPe, fairPe, fairPrice, upside,
    };
  };

  return {
    pessimistic: make(0.5, fairPePessimistic),
    base: make(1.0, fairPeBase),
    optimistic: make(1.5, fairPeOptimistic),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 3. CN 風險旗推導
// ────────────────────────────────────────────────────────────────────────────

interface CnFlagInferenceInput {
  deductedRatio: number | null;
  pbRatio: number | null;
  roe: number | null;
  industryTemplate: ReturnType<typeof detectIndustryTemplateFor>;
  parentNetProfitYoY: number | null;
  deductedNetProfitYoY: number | null;
}

export function inferCnRiskFlags(inp: CnFlagInferenceInput): RiskFlag[] {
  const flags: RiskFlag[] = [];

  // 扣非占比偏低（< 50%）→ 一次性收益旗
  if (inp.deductedRatio != null && inp.deductedRatio < 0.5) {
    flags.push('one_time_gain');
  }
  // 歸母 YoY 高但扣非 YoY 低 — 業外撐起來的成長
  if (
    inp.parentNetProfitYoY != null && inp.parentNetProfitYoY > 50 &&
    inp.deductedNetProfitYoY != null && inp.deductedNetProfitYoY < 20
  ) {
    if (!flags.includes('one_time_gain')) flags.push('one_time_gain');
  }

  // 景氣循環高峰
  if (inp.industryTemplate === 'cyclical' && (inp.pbRatio ?? 0) > 2 && (inp.roe ?? 0) > 20) {
    flags.push('cyclical_peak');
  }
  // PB 過熱
  if (inp.industryTemplate !== 'cyclical' && (inp.pbRatio ?? 0) > 8) {
    flags.push('pb_overheated');
  }

  return flags;
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 主 pipeline
// ────────────────────────────────────────────────────────────────────────────

export interface CnPipelineInput {
  symbol: string;
  name: string;
  todayPrice: number;
  priceDate: string;
  /** 由呼叫端從產業 API 帶入；沒有就用 stockId 推（東財 push2 f127 — 後續可補） */
  industryCategory?: string | null;
  averageTurnover20d?: number | null;
}

export async function runCnSingle(
  inp: CnPipelineInput,
): Promise<FundamentalRevaluationResult | null> {
  const filter = applyCnHardFilter(inp);
  if (!filter.passed) return null;

  const [fundResult, detailResult] = await Promise.all([
    getEastMoneyFundamentals(inp.symbol),
    getEastMoneyFinancialDetail(inp.symbol),
  ]);

  if (!fundResult && !detailResult) return null;  // 完全沒資料

  const latest = latestQuarter(detailResult);
  const dedRatio = deductedNetProfitRatio(detailResult);

  const industryCategory = inp.industryCategory ?? null;
  const industryTemplate = detectIndustryTemplateFor('CN', industryCategory);
  const peRange = getReasonablePe(industryTemplate);

  // TTM EPS — 從 detail.quarters 取近 4 季 EPS
  let ttmEps: number | null = null;
  if (detailResult && detailResult.quarters.length >= 4) {
    ttmEps = detailResult.quarters.slice(0, 4).reduce((s, q) => s + (q.eps ?? 0), 0);
  } else if (fundResult?.latestQuarterEps != null) {
    // fallback：以動態 PE 反推
    ttmEps = fundResult.latestQuarterEps * 4;
  }

  const ttmPe = ttmEps != null && ttmEps > 0 ? computeTTMPe(inp.todayPrice, ttmEps) : null;

  // 風險旗
  const riskFlags = inferCnRiskFlags({
    deductedRatio: dedRatio,
    pbRatio: fundResult?.pbRatio ?? null,
    roe: latest?.roe ?? null,
    industryTemplate,
    parentNetProfitYoY: latest?.parentNetProfitYoY ?? null,
    deductedNetProfitYoY: latest?.deductedNetProfitYoY ?? null,
  });

  // 三情境
  const scenarios = buildCnScenarios({
    ttmEps,
    parentNetProfitYoY: latest?.parentNetProfitYoY ?? null,
    deductedNetProfitYoY: latest?.deductedNetProfitYoY ?? null,
    deductedRatio: dedRatio,
    todayPrice: inp.todayPrice,
    fairPePessimistic: peRange.pessimistic,
    fairPeBase: peRange.base,
    fairPeOptimistic: peRange.optimistic,
  });

  // 組 bundle
  const bundle: CnFundamentalBundle = {
    symbol: inp.symbol,
    name: inp.name,
    market: 'CN',
    industryCategory,
    industryTemplate,
    todayPrice: inp.todayPrice,
    priceDate: inp.priceDate,
    latestQuarterEps: fundResult?.latestQuarterEps ?? latest?.eps ?? null,
    ttmEps,
    ttmPe,
    dynamicPe: fundResult?.dynamicPe ?? null,
    staticPe: fundResult?.staticPe ?? null,
    pbRatio: fundResult?.pbRatio ?? null,
    bookValuePerShare: fundResult?.bookValuePerShare ?? latest?.bookValuePerShare ?? null,
    totalShares: fundResult?.totalShares ?? null,
    floatShares: fundResult?.floatShares ?? null,
    marketCap: fundResult?.totalShares && fundResult.totalShares > 0
      ? fundResult.totalShares * inp.todayPrice
      : null,
    latestQuarterRevenue: latest?.revenue ?? null,
    latestQuarterRevenueYoY: latest?.revenueYoY ?? null,
    latestQuarterNetProfitParent: latest?.parentNetProfit ?? null,
    latestQuarterNetProfitParentYoY: latest?.parentNetProfitYoY ?? null,
    latestQuarterDeductedNetProfit: latest?.deductedNetProfit ?? null,
    latestQuarterDeductedNetProfitYoY: latest?.deductedNetProfitYoY ?? null,
    deductedNetProfitRatio: dedRatio,
    latestGrossMargin: latest?.grossMargin ?? null,
    latestNetMargin: latest?.netMargin ?? null,
    roe: latest?.roe ?? null,
    operatingCashFlow: null,       // V2 補
    inventoryYoY: null,            // V2 補
    accountsReceivableYoY: null,   // V2 補
    peRange,
    riskFlags,
    dataCompleteness: computeCnDataCompleteness({
      hasFundamentals: fundResult != null,
      hasDetail: detailResult != null,
      hasIndustry: industryCategory != null,
      hasYoY: latest?.revenueYoY != null,
      hasDeducted: latest?.deductedNetProfit != null,
    }),
  };

  // 評分
  const flags = deriveCnFlags(bundle, scenarios);
  const growth = scoreCnGrowth(bundle);
  const profitability = scoreCnProfitability(bundle);
  const valuationDim = scoreValuation({
    forwardPeBase: scenarios.base.forwardPe === Infinity ? null : scenarios.base.forwardPe,
    fairPeBase: peRange.base,
    baseUpside: scenarios.base.upside,
    optimisticOnly: scenarios.optimistic.upside >= 0.2 && scenarios.base.upside < 0.2,
    pbRatio: bundle.pbRatio,
    ttmPe,
  });
  const risk = scoreRisk({
    hasOneTimeGain: riskFlags.includes('one_time_gain'),
    oneTimeGainImpactPct: dedRatio != null ? (1 - dedRatio) * 100 : null,
    cyclicalPeak: riskFlags.includes('cyclical_peak'),
    pbOverheated: riskFlags.includes('pb_overheated'),
    dilutionPending: false,  // CN 不抓增資公告（V2 補巨潮）
  });
  const breakdown = buildBreakdown({ growth, profitability, valuation: valuationDim, risk, flags });

  // 看多/風險摘要
  const bullPoints = pickTopReasons([...growth.items, ...profitability.items, ...valuationDim.items], 3);
  const riskPoints = pickTopReasons(risk.items.filter((i) => i.delta < 0), 3);

  const validationConditions: string[] = [];
  if (latest?.revenueYoY != null) {
    validationConditions.push(`追蹤下一季營收 YoY 是否維持 > ${Math.max(latest.revenueYoY * 0.7, 20).toFixed(0)}%`);
  }
  if (dedRatio != null) {
    validationConditions.push(`下一季扣非淨利占比是否維持 > ${Math.max(dedRatio * 100 - 5, 60).toFixed(0)}%`);
  }

  return {
    symbol: inp.symbol,
    name: inp.name,
    market: 'CN',
    rank: 0,
    breakdown,
    scenarios,
    ttmEps,
    ttmPe,
    todayPrice: inp.todayPrice,
    baseFairPrice: scenarios.base.fairPrice > 0 ? scenarios.base.fairPrice : null,
    baseUpside: scenarios.base.fairPrice > 0 ? scenarios.base.upside : null,
    dataCompleteness: bundle.dataCompleteness,
    bullPoints,
    riskPoints,
    validationConditions,
    bundle,
    computedAt: new Date().toISOString(),
    strategyVersion: STRATEGY_VERSION,
  };
}

function pickTopReasons(items: Array<{ delta: number; reason: string }>, n: number): string[] {
  return items
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, n)
    .map((it) => it.reason);
}

function computeCnDataCompleteness(parts: {
  hasFundamentals: boolean;
  hasDetail: boolean;
  hasIndustry: boolean;
  hasYoY: boolean;
  hasDeducted: boolean;
}): number {
  const weights = [
    { ok: parts.hasFundamentals, w: 0.25 },
    { ok: parts.hasDetail, w: 0.30 },
    { ok: parts.hasYoY, w: 0.20 },
    { ok: parts.hasDeducted, w: 0.15 },
    { ok: parts.hasIndustry, w: 0.10 },
  ];
  return weights.reduce((s, p) => s + (p.ok ? p.w : 0), 0);
}
