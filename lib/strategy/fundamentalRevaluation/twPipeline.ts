/**
 * TW 基本面補漲策略 Pipeline（Phase 1 程式端，2026-05-27）
 *
 * 流程：
 *   1. 硬條件過濾（早期淘汰）
 *   2. 並行取資料（FinMind 月營收/季報/股數/資產負債/產業 + MOPS 稀釋）
 *   3. 推導旗（一次性收益 / 景氣高峰 / 增資稀釋 等）
 *   4. 推估 Forward EPS（保守/中性/樂觀三情境，reuse lib/valuation/scenario.ts）
 *   5. 評分（4 × 25）
 *   6. 輸出 FundamentalRevaluationResult
 *
 * 不過：六條件、戒律、淘汰法、Step 0 大盤過濾、MTF、KD向下警示。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  getMonthlyRevenue,
  getQuarterlyHistory,
  getSharesIssued,
  getBalanceSheet,
  getStockInfo,
  type RevenueRow,
  type QuarterlyHistoryRow,
} from '@/lib/datasource/FinMindClient';

import { computeTTM, computeTTMPe } from '@/lib/valuation/ttm';
import { computeAllScenarios } from '@/lib/valuation/scenario';
import { detectIndustryTemplateFor, getReasonablePe } from './industryReasonablePe';

import type {
  QuarterRow,
  MonthlyRevenueRow,
  DilutionEvent,
  RiskFlag,
  ScenarioAssumption,
  ScenarioKey,
} from '@/lib/valuation/types';

import {
  scoreTwGrowth,
  scoreTwProfitability,
  scoreValuation,
  scoreRisk,
  buildBreakdown,
} from './scoring';

import { deriveTwFlags } from './recommendationGrade';

import type {
  TwFundamentalBundle,
  FundamentalRevaluationResult,
  HardFilterResult,
} from './types';

const STRATEGY_VERSION = 'tw-fundamental-revaluation@1.0.0';

// ────────────────────────────────────────────────────────────────────────────
// 1. 硬條件（早期淘汰）— 不用打 API，先用 scan layer-2 行情 + 簡單 sanity check
// ────────────────────────────────────────────────────────────────────────────

export interface HardFilterInput {
  symbol: string;
  todayPrice: number | null;
  averageTurnover20d?: number | null;   // 成交額 20 日均
}

export function applyTwHardFilter(inp: HardFilterInput): HardFilterResult {
  if (!inp.symbol) return { passed: false, failedReason: 'no_symbol' };
  if (!inp.todayPrice || inp.todayPrice <= 0) return { passed: false, failedReason: 'no_price' };
  if (inp.todayPrice < 5) return { passed: false, failedReason: 'price_too_low' };
  // 成交額過低（< 1000 萬 NTD 日均）不在補漲範圍
  if (inp.averageTurnover20d != null && inp.averageTurnover20d < 10_000_000) {
    return { passed: false, failedReason: 'turnover_too_low' };
  }
  return { passed: true };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 月營收衍生欄位
// ────────────────────────────────────────────────────────────────────────────

interface DerivedMonthly {
  monthly: MonthlyRevenueRow[];
  latestYoY: number | null;
  latestMoM: number | null;
  cumulativeYoY: number | null;
  last3MonthYoY: number | null;
  consecutiveGrowthMonths: number;
  isLatest12mHigh: boolean;
  isAllTimeHigh: boolean;
}

export function deriveMonthly(rows: RevenueRow[]): DerivedMonthly {
  if (!rows || rows.length === 0) {
    return {
      monthly: [],
      latestYoY: null,
      latestMoM: null,
      cumulativeYoY: null,
      last3MonthYoY: null,
      consecutiveGrowthMonths: 0,
      isLatest12mHigh: false,
      isAllTimeHigh: false,
    };
  }

  // 由近到遠
  const sorted = [...rows].sort((a, b) => {
    if (a.revenue_year !== b.revenue_year) return b.revenue_year - a.revenue_year;
    return b.revenue_month - a.revenue_month;
  });

  const monthly: MonthlyRevenueRow[] = sorted.map((r, i, arr) => {
    const ymStr = `${r.revenue_year}-${String(r.revenue_month).padStart(2, '0')}`;
    const prevYear = arr.find((x) => x.revenue_year === r.revenue_year - 1 && x.revenue_month === r.revenue_month);
    const prevMonth = arr[i + 1];
    const yoy = prevYear && prevYear.revenue > 0 ? (r.revenue / prevYear.revenue - 1) * 100 : undefined;
    const mom = prevMonth && prevMonth.revenue > 0 ? (r.revenue / prevMonth.revenue - 1) * 100 : undefined;
    return { month: ymStr, revenue: r.revenue, yoy, mom };
  });

  const latest = monthly[0];
  const latestYoY = latest?.yoy ?? null;
  const latestMoM = latest?.mom ?? null;

  // 累計：今年 1-N 月 vs 去年 1-N 月（N = latest 月份）
  const latestYear = sorted[0].revenue_year;
  const latestMonth = sorted[0].revenue_month;
  const thisYearTotal = sorted
    .filter((r) => r.revenue_year === latestYear && r.revenue_month <= latestMonth)
    .reduce((s, r) => s + r.revenue, 0);
  const lastYearTotal = sorted
    .filter((r) => r.revenue_year === latestYear - 1 && r.revenue_month <= latestMonth)
    .reduce((s, r) => s + r.revenue, 0);
  const cumulativeYoY = lastYearTotal > 0 ? (thisYearTotal / lastYearTotal - 1) * 100 : null;

  // 近 3 月 YoY 平均
  const last3 = monthly.slice(0, 3).map((m) => m.yoy).filter((v): v is number => v != null);
  const last3MonthYoY = last3.length === 3 ? last3.reduce((a, b) => a + b, 0) / 3 : null;

  // 連續成長月數
  let consecutive = 0;
  for (const m of monthly) {
    if (m.yoy == null) break;
    if (m.yoy > 0 && consecutive >= 0) consecutive++;
    else if (m.yoy < 0 && consecutive <= 0) consecutive--;
    else break;
  }

  // 12 月新高 / 歷史新高
  const isLatest12mHigh = monthly.slice(0, 12).every((m) => m.revenue <= latest.revenue);
  const isAllTimeHigh = monthly.every((m) => m.revenue <= latest.revenue);

  return {
    monthly,
    latestYoY,
    latestMoM,
    cumulativeYoY,
    last3MonthYoY,
    consecutiveGrowthMonths: consecutive,
    isLatest12mHigh,
    isAllTimeHigh,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 季報衍生欄位
// ────────────────────────────────────────────────────────────────────────────

function quartersToQuarterRow(rows: QuarterlyHistoryRow[]): QuarterRow[] {
  return rows.map((r) => ({
    quarter: r.quarter,
    revenue: r.revenue ?? 0,
    grossProfit: r.grossProfit ?? undefined,
    netIncome: r.netIncome ?? 0,
    eps: r.eps ?? 0,
    netMargin: r.netMargin ?? undefined,
  }));
}

interface QuarterDerived {
  quarters: QuarterRow[];
  latestEps: number | null;
  latestEpsYoY: number | null;
  latestEpsQoQ: number | null;
  latestGrossMargin: number | null;
  latestNetMargin: number | null;
  /** 用 lib/valuation/ttm.ts computeTTM */
  ttmEps: number | null;
}

export function deriveQuarters(rows: QuarterlyHistoryRow[]): QuarterDerived {
  const quarters = quartersToQuarterRow(rows);
  if (quarters.length === 0) {
    return {
      quarters: [],
      latestEps: null,
      latestEpsYoY: null,
      latestEpsQoQ: null,
      latestGrossMargin: null,
      latestNetMargin: null,
      ttmEps: null,
    };
  }

  const cur = quarters[0];
  const prevQuarter = quarters[1];
  const prevYearSameQuarter = quarters.find((q, i) => i >= 4 && i <= 5 && q !== cur) ?? quarters[4];

  const latestEps = cur.eps ?? null;
  const latestEpsYoY = prevYearSameQuarter && prevYearSameQuarter.eps && Math.abs(prevYearSameQuarter.eps) > 0.01
    ? (cur.eps / prevYearSameQuarter.eps - 1) * 100
    : null;
  const latestEpsQoQ = prevQuarter && prevQuarter.eps && Math.abs(prevQuarter.eps) > 0.01
    ? (cur.eps / prevQuarter.eps - 1) * 100
    : null;
  const latestGrossMargin = cur.grossProfit != null && cur.revenue > 0 ? (cur.grossProfit / cur.revenue) * 100 : null;
  const latestNetMargin = cur.netMargin != null ? cur.netMargin * 100 : null;

  const ttm = computeTTM(quarters);
  return {
    quarters,
    latestEps,
    latestEpsYoY,
    latestEpsQoQ,
    latestGrossMargin,
    latestNetMargin,
    ttmEps: ttm?.ttmEps ?? null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 稀釋公告（data/dilution/{symbol}.json）
// ────────────────────────────────────────────────────────────────────────────

async function readDilution(symbol: string): Promise<DilutionEvent[]> {
  const filePath = path.join(process.cwd(), 'data', 'dilution', `${symbol}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is DilutionEvent =>
      e && typeof e === 'object' && typeof e.type === 'string' && typeof e.newShares === 'number',
    );
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 5. 旗推導（程式可識別 — skill 會補語意性的）
// ────────────────────────────────────────────────────────────────────────────

interface FlagInferenceInput {
  ttmEps: number | null;
  /** 當季淨利率（百分比，e.g. 34 表 34%） */
  latestNetMargin: number | null;
  /** 上一季淨利率（百分比） */
  previousNetMargin: number | null;
  pbRatio: number | null;
  roe: number | null;
  industryTemplate: ReturnType<typeof detectIndustryTemplateFor>;
  hasMonthlyRevenue: boolean;
  dilutionPending: boolean;
  /** 業外損益佔當季稅後淨利的 % — 沒資料時填 null */
  nonOperatingPctOfNet?: number | null;
}

export function inferRiskFlags(inp: FlagInferenceInput): RiskFlag[] {
  const flags: RiskFlag[] = [];

  // 一次性收益啟發式：當季淨利率 vs 上一季差距超過 10pp（巨幅跳升）
  // 兩邊都用「百分比」(e.g. 30 表 30%)
  if (
    inp.latestNetMargin != null &&
    inp.previousNetMargin != null &&
    inp.latestNetMargin - inp.previousNetMargin > 10
  ) {
    flags.push('one_time_gain');
  }
  // 業外貢獻過高（如果取得到）
  if (inp.nonOperatingPctOfNet != null && inp.nonOperatingPctOfNet > 30) {
    if (!flags.includes('one_time_gain')) flags.push('one_time_gain');
  }

  // 景氣循環高峰：景氣循環產業 + PB > 2 + ROE > 20%
  if (inp.industryTemplate === 'cyclical' && (inp.pbRatio ?? 0) > 2 && (inp.roe ?? 0) > 20) {
    flags.push('cyclical_peak');
  }

  // PB 過熱（非景氣股 PB > 5）
  if (inp.industryTemplate !== 'cyclical' && (inp.pbRatio ?? 0) > 5) {
    flags.push('pb_overheated');
  }

  // 月營收資料缺
  if (!inp.hasMonthlyRevenue) flags.push('monthly_revenue_pending');

  // 稀釋等待中
  if (inp.dilutionPending) flags.push('dilution_pending');

  // 毛利下滑但營收增 — 由 caller 提供
  // foreign_currency_sensitive 等需語意判斷 — 留給 skill
  return flags;
}

// ────────────────────────────────────────────────────────────────────────────
// 6. Forward EPS 三情境推估
// ────────────────────────────────────────────────────────────────────────────

interface ScenarioPlanInput {
  quarters: QuarterRow[];
  shares: number;
  /** 三情境用「當季淨利率」為基準 ± 偏差；若旗有 one_time_gain，用前一季淨利率作為「本業淨利率」基準 */
  baseNetMargin: number;
  /** 4 月實際營收（partialQuarter）— 用最新月營收當代理。沒有就 0 */
  partialQuarterRevenue: number;
  /** Q1 已知營收（最近季的 revenue） */
  q1Revenue: number;
}

function buildScenarioAssumptions(
  inp: ScenarioPlanInput,
): Record<ScenarioKey, ScenarioAssumption> {
  // 簡化模型：用 Q1 revenue 當基準營收，Q2-Q4 按情境設成長率
  const baseRev = inp.q1Revenue;
  if (!baseRev || baseRev <= 0) {
    // 無 Q1 營收 → 三情境均回 0，由 scoring 端對應跳過
    const zero: ScenarioAssumption = {
      q2Revenue: 0, q3Revenue: 0, q4Revenue: 0,
      q2NetMargin: 0, q3NetMargin: 0, q4NetMargin: 0,
      partialQuarterRevenue: inp.partialQuarterRevenue,
    };
    return { pessimistic: zero, base: zero, optimistic: zero };
  }

  const margin = inp.baseNetMargin > 0 ? inp.baseNetMargin : 0;

  return {
    pessimistic: {
      q2Revenue: baseRev * 0.95,
      q3Revenue: baseRev * 0.95,
      q4Revenue: baseRev * 0.95,
      q2NetMargin: Math.max(margin - 0.02, 0.01),
      q3NetMargin: Math.max(margin - 0.02, 0.01),
      q4NetMargin: Math.max(margin - 0.02, 0.01),
      partialQuarterRevenue: inp.partialQuarterRevenue,
    },
    base: {
      q2Revenue: baseRev * 1.05,
      q3Revenue: baseRev * 1.10,
      q4Revenue: baseRev * 1.10,
      q2NetMargin: margin,
      q3NetMargin: margin,
      q4NetMargin: margin,
      partialQuarterRevenue: inp.partialQuarterRevenue,
    },
    optimistic: {
      q2Revenue: baseRev * 1.15,
      q3Revenue: baseRev * 1.25,
      q4Revenue: baseRev * 1.30,
      q2NetMargin: margin + 0.02,
      q3NetMargin: margin + 0.02,
      q4NetMargin: margin + 0.02,
      partialQuarterRevenue: inp.partialQuarterRevenue,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 7. 主 pipeline — 對單檔股票
// ────────────────────────────────────────────────────────────────────────────

export interface TwPipelineInput {
  symbol: string;
  name: string;
  todayPrice: number;
  priceDate: string;
  averageTurnover20d?: number | null;
}

export async function runTwSingle(
  inp: TwPipelineInput,
): Promise<FundamentalRevaluationResult | null> {
  // 1. 硬條件
  const filter = applyTwHardFilter(inp);
  if (!filter.passed) return null;

  // 2. 並行取資料
  const [revenueRows, quarterRows, sharesRaw, balance, info, dilution] = await Promise.all([
    getMonthlyRevenue(inp.symbol, 24).catch(() => [] as RevenueRow[]),
    getQuarterlyHistory(inp.symbol, 8).catch(() => [] as QuarterlyHistoryRow[]),
    getSharesIssued(inp.symbol).catch(() => null),
    getBalanceSheet(inp.symbol).catch(() => null),
    getStockInfo(inp.symbol).catch(() => null),
    readDilution(inp.symbol),
  ]);

  // 3. 衍生
  const monthlyDerived = deriveMonthly(revenueRows);
  const quartersDerived = deriveQuarters(quarterRows);
  const shares = sharesRaw ?? null;
  const pbRatio = balance?.bookValuePerShare && balance.bookValuePerShare > 0
    ? inp.todayPrice / balance.bookValuePerShare
    : null;
  const industryCategory = info?.industry_category ?? null;
  const industryTemplate = detectIndustryTemplateFor('TW', industryCategory);
  const peRange = getReasonablePe(industryTemplate);
  const ttmPe = quartersDerived.ttmEps != null && quartersDerived.ttmEps > 0
    ? computeTTMPe(inp.todayPrice, quartersDerived.ttmEps)
    : null;

  // 4. ROE = 4Q netIncome / equity
  let roe: number | null = null;
  if (balance?.equity && balance.equity > 0 && quartersDerived.quarters.length >= 4) {
    const ttmNI = quartersDerived.quarters.slice(0, 4).reduce((s, q) => s + (q.netIncome ?? 0), 0);
    roe = (ttmNI / balance.equity) * 100;
  }

  // 5. 風險旗
  const previousNetMargin = quartersDerived.quarters[1]?.netMargin ?? null;
  const dilutionPending = dilution.some((d) => {
    if (!d.expectedDate) return false;
    return new Date(d.expectedDate).getTime() > Date.now();
  });
  // 統一傳「百分比」(latestNetMargin 已是 *100；previousNetMargin 是 fraction，*100)
  const riskFlags = inferRiskFlags({
    ttmEps: quartersDerived.ttmEps,
    latestNetMargin: quartersDerived.latestNetMargin,
    previousNetMargin: previousNetMargin != null ? previousNetMargin * 100 : null,
    pbRatio,
    roe,
    industryTemplate,
    hasMonthlyRevenue: monthlyDerived.monthly.length > 0,
    dilutionPending,
  });

  // 6. Forward EPS 三情境
  const q1Revenue = quartersDerived.quarters[0]?.revenue ?? 0;
  const baseNetMargin = (() => {
    // 一次性收益旗 → 用前一季淨利率
    if (riskFlags.includes('one_time_gain') && previousNetMargin != null) return previousNetMargin;
    if (quartersDerived.latestNetMargin != null) return quartersDerived.latestNetMargin / 100;
    return 0;
  })();
  const partialQuarterRevenue = monthlyDerived.monthly[0]?.revenue ?? 0;
  const assumptions = buildScenarioAssumptions({
    quarters: quartersDerived.quarters,
    shares: shares ?? 0,
    baseNetMargin,
    partialQuarterRevenue,
    q1Revenue,
  });
  const scenarios = shares && shares > 0
    ? computeAllScenarios(quartersDerived.quarters, assumptions, shares, peRange, inp.todayPrice)
    : {
        pessimistic: { q2Eps: 0, q3Eps: 0, q4Eps: 0, fullYearEps: 0, forwardPe: Infinity, fairPe: peRange.pessimistic, fairPrice: 0, upside: 0 },
        base: { q2Eps: 0, q3Eps: 0, q4Eps: 0, fullYearEps: 0, forwardPe: Infinity, fairPe: peRange.base, fairPrice: 0, upside: 0 },
        optimistic: { q2Eps: 0, q3Eps: 0, q4Eps: 0, fullYearEps: 0, forwardPe: Infinity, fairPe: peRange.optimistic, fairPrice: 0, upside: 0 },
      };

  // 7. 組 bundle
  const bundle: TwFundamentalBundle = {
    symbol: inp.symbol,
    name: inp.name,
    market: 'TW',
    industryCategory,
    industryTemplate,
    todayPrice: inp.todayPrice,
    priceDate: inp.priceDate,
    monthlyRevenue: monthlyDerived.monthly,
    latestMonthRevenueYoY: monthlyDerived.latestYoY,
    latestMonthRevenueMoM: monthlyDerived.latestMoM,
    cumulativeRevenueYoY: monthlyDerived.cumulativeYoY,
    last3MonthRevenueYoY: monthlyDerived.last3MonthYoY,
    consecutiveGrowthMonths: monthlyDerived.consecutiveGrowthMonths,
    isLatest12mHigh: monthlyDerived.isLatest12mHigh,
    isAllTimeHigh: monthlyDerived.isAllTimeHigh,
    quarters: quartersDerived.quarters,
    latestQuarterEps: quartersDerived.latestEps,
    latestQuarterEpsYoY: quartersDerived.latestEpsYoY,
    latestQuarterEpsQoQ: quartersDerived.latestEpsQoQ,
    latestGrossMargin: quartersDerived.latestGrossMargin,
    latestNetMargin: quartersDerived.latestNetMargin,
    latestRoe: roe,
    ttmEps: quartersDerived.ttmEps,
    ttmPe,
    bookValuePerShare: balance?.bookValuePerShare ?? null,
    pbRatio,
    sharesOutstanding: shares,
    peRange,
    dilutionEvents: dilution,
    riskFlags,
    dataCompleteness: computeTwDataCompleteness({
      hasRevenue: monthlyDerived.monthly.length > 0,
      hasQuarter: quartersDerived.quarters.length > 0,
      hasShares: shares != null,
      hasBalance: balance != null,
      hasInfo: info != null,
    }),
  };

  // 8. 評分
  const flags = deriveTwFlags(bundle, scenarios);
  const growth = scoreTwGrowth(bundle);
  const profitability = scoreTwProfitability(bundle);
  const valuationDim = scoreValuation({
    forwardPeBase: scenarios.base.forwardPe === Infinity ? null : scenarios.base.forwardPe,
    fairPeBase: peRange.base,
    baseUpside: scenarios.base.upside,
    optimisticOnly: scenarios.optimistic.upside >= 0.2 && scenarios.base.upside < 0.2,
    pbRatio,
    ttmPe,
  });
  const risk = scoreRisk({
    hasOneTimeGain: riskFlags.includes('one_time_gain'),
    cyclicalPeak: riskFlags.includes('cyclical_peak'),
    pbOverheated: riskFlags.includes('pb_overheated'),
    dilutionPending: riskFlags.includes('dilution_pending'),
  });
  const breakdown = buildBreakdown({ growth, profitability, valuation: valuationDim, risk, flags });

  // 9. 看多/風險摘要（程式產出，skill 會補敘述）
  const bullPoints = pickTopReasons([...growth.items, ...profitability.items, ...valuationDim.items], 3);
  const riskPoints = pickTopReasons(risk.items.filter((i) => i.delta < 0), 3);

  const validationConditions: string[] = [];
  if (monthlyDerived.monthly.length > 0) {
    validationConditions.push('追蹤次月營收 YoY 是否維持 > 20%');
  }
  if (scenarios.base.fairPrice > 0) {
    validationConditions.push(`下一季季報 EPS 是否達中性情境（${scenarios.base.q2Eps.toFixed(2)}）`);
  }

  return {
    symbol: inp.symbol,
    name: inp.name,
    market: 'TW',
    rank: 0,    // pipeline runner 排序後再填
    breakdown,
    scenarios,
    ttmEps: quartersDerived.ttmEps,
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

function computeTwDataCompleteness(parts: {
  hasRevenue: boolean;
  hasQuarter: boolean;
  hasShares: boolean;
  hasBalance: boolean;
  hasInfo: boolean;
}): number {
  const weights = [
    { ok: parts.hasRevenue, w: 0.30 },
    { ok: parts.hasQuarter, w: 0.35 },
    { ok: parts.hasShares, w: 0.15 },
    { ok: parts.hasBalance, w: 0.10 },
    { ok: parts.hasInfo, w: 0.10 },
  ];
  return weights.reduce((s, p) => s + (p.ok ? p.w : 0), 0);
}
