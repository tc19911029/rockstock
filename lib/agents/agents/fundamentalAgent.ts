/**
 * Fundamental Agent (Agent D) — 基本面 prefetch + question builder
 *
 * 紅線：
 *   - 只看月營收 / EPS / 毛利率 / 估值 / 產業
 *   - dataPoints category 必須是 'fundamental' | 'valuation' | 'industry'
 *   - 禁止評論價格走勢
 *
 * v2 強化（2026-05-27）：除既有 fundamentals 11 欄外，新增 valuationInputs：
 *   - 近 8 季逐季財報、近 12 月營收、流通股數、每股淨值
 *   - 程式預先算 TTM EPS / TTM PE / industry template / reasonable PE range
 *   - 讀 data/dilution/{symbol}.json 補 GDR/增資/CB 公告
 *   - 給 skill 用來算三情境 + 合理股價 + 稀釋後 EPS
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fetchJSON, internalUrl, bareTicker } from './_fetchHelper';
import {
  AGENT_SCHEMA_VERSION,
  FundamentalGroundTruth,
  FundamentalQuestion,
} from '@/lib/agents/types';
import type { MarketId } from '@/lib/scanner/types';
import type { Candidate } from '@/lib/agents/candidates/types';
import { sliceSourcesForAgent } from '@/lib/agents/candidates/types';
import {
  getQuarterlyHistory,
  getMonthlyRevenue,
  getSharesIssued,
  getBalanceSheet,
  getStockInfo,
} from '@/lib/datasource/FinMindClient';
import { getEastMoneyFundamentals } from '@/lib/datasource/EastMoneyFundamentals';
import {
  computeTTM,
  computeTTMPe,
  computeDynamicPe,
  computeStaticPe,
  computeLastYearEps,
} from '@/lib/valuation/ttm';
import {
  detectIndustryTemplate,
  getReasonablePeRange,
  getTemplateLabel,
} from '@/lib/valuation/industryTemplate';

// ────────────────────────────────────────────────────────────────────────────

export interface BuildFundamentalQuestionArgs {
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  /** 已從 candidateRow.name 取 */
  name: string;
  /** 已從 candidateRow.industry 取（可能 undefined）*/
  industry?: string;
  candidate?: Candidate;
}

export async function buildFundamentalQuestion(
  args: BuildFundamentalQuestionArgs,
): Promise<FundamentalQuestion> {
  const { runId, date, symbol, market, name, industry, candidate } = args;
  const fetchErrors: string[] = [];

  const fundamentalsRaw = await fetchJSON(
    internalUrl(`/api/fundamentals/${encodeURIComponent(symbol)}?mode=full`),
  ).catch((e) => { fetchErrors.push(`fundamentals: ${e}`); return null; });

  const fundamentals = normaliseFundamentals(fundamentalsRaw);
  if (!fundamentals) fetchErrors.push('fundamentals api returned null');

  // 估值分析輸入 — 台股走 FinMind，陸股走 EastMoney
  const valuationInputs = market === 'TW'
    ? await buildValuationInputsTW(symbol, industry, fetchErrors)
    : market === 'CN'
    ? await buildValuationInputsCN(symbol, industry, fetchErrors)
    : undefined;

  const groundTruth: FundamentalGroundTruth = {
    symbol,
    name: name || null,
    fundamentals,
    industry: industry ?? null,
    valuationInputs,
    fetchErrors,
  };

  const question: FundamentalQuestion = {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'fundamental',
    runId,
    date,
    symbol,
    market,
    groundTruth,
  };
  if (candidate) {
    question.entryContext = {
      sources: sliceSourcesForAgent(candidate.sources, 'fundamental') as Pick<
        Candidate['sources'], 'fundamental'
      >,
      sourceCount: candidate.sourceCount,
    };
  }
  return question;
}

// ────────────────────────────────────────────────────────────────────────────

function normaliseFundamentals(raw: unknown): FundamentalGroundTruth['fundamentals'] {
  if (!raw || typeof raw !== 'object') return null;
  // apiOk 包成 { ok: true, data: {...} }
  const wrapper = raw as { data?: unknown };
  const data = wrapper.data && typeof wrapper.data === 'object' ? wrapper.data : raw;
  const r = data as Record<string, unknown>;

  const numOrNull = (k: string): number | null => {
    const v = r[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  return {
    eps:            numOrNull('eps'),
    epsYoY:         numOrNull('epsYoY'),
    grossMargin:    numOrNull('grossMargin'),
    netMargin:      numOrNull('netMargin'),
    per:            numOrNull('per'),
    pbr:            numOrNull('pbr'),
    dividendYield:  numOrNull('dividendYield'),
    revenueLatest:  numOrNull('revenueLatest'),
    revenueMoM:     numOrNull('revenueMoM'),
    revenueYoY:     numOrNull('revenueYoY'),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// v2: 估值分析輸入
// ────────────────────────────────────────────────────────────────────────────

export async function buildValuationInputsTW(
  symbol: string,
  industryHint: string | undefined,
  fetchErrors: string[],
): Promise<FundamentalGroundTruth['valuationInputs']> {
  const ticker = bareTicker(symbol);

  const [
    quoteRaw,
    quarterly,
    monthly,
    shares,
    balance,
    stockInfo,
    dilution,
  ] = await Promise.all([
    fetchJSON(internalUrl(`/api/stock/quote?symbol=${encodeURIComponent(symbol)}`))
      .catch((e) => { fetchErrors.push(`quote: ${e}`); return null; }),
    getQuarterlyHistory(ticker, 8).catch((e) => { fetchErrors.push(`quarterly: ${e}`); return []; }),
    getMonthlyRevenue(ticker, 12).catch((e) => { fetchErrors.push(`monthly: ${e}`); return []; }),
    getSharesIssued(ticker).catch((e) => { fetchErrors.push(`shares: ${e}`); return null; }),
    getBalanceSheet(ticker).catch((e) => { fetchErrors.push(`balanceSheet: ${e}`); return null; }),
    getStockInfo(ticker).catch((e) => { fetchErrors.push(`stockInfo: ${e}`); return null; }),
    readDilutionEvents(ticker).catch((e) => { fetchErrors.push(`dilution: ${e}`); return []; }),
  ]);

  // 解 quote API 的 apiOk 包裝
  const quote = unwrapApi(quoteRaw) as { close?: number } | null;
  const currentPrice = typeof quote?.close === 'number' ? quote.close : null;

  // TTM 計算
  const ttm = computeTTM(
    quarterly.map((q) => ({
      quarter: q.quarter,
      revenue: q.revenue ?? 0,
      grossProfit: q.grossProfit ?? undefined,
      netIncome: q.netIncome ?? 0,
      eps: q.eps ?? 0,
      netMargin: q.netMargin ?? undefined,
    })),
  );
  const ttmEps = ttm?.ttmEps ?? null;
  const ttmPe = ttmEps && currentPrice ? computeTTMPe(currentPrice, ttmEps) : null;

  // 動態 / 靜態 PE
  const latestQuarterEps = quarterly[0]?.eps ?? null;
  const dynamicPe = latestQuarterEps && currentPrice
    ? computeDynamicPe(currentPrice, latestQuarterEps)
    : null;
  const lastYearTotalEps = computeLastYearEps(
    quarterly.map((q) => ({
      quarter: q.quarter,
      revenue: q.revenue ?? 0,
      netIncome: q.netIncome ?? 0,
      eps: q.eps ?? 0,
    })),
  );
  const staticPe = lastYearTotalEps && currentPrice
    ? computeStaticPe(currentPrice, lastYearTotalEps)
    : null;

  // 產業模板 — 優先用 FinMind 真實 industry_category（更精確），fallback candidate.industry
  // candidate.industry 經常是上層分類（如「其他電子業」），無法 detect 出 ASIC
  const industryStr = stockInfo?.industry_category ?? industryHint ?? null;
  const template = detectIndustryTemplate(industryStr);
  const peRange = getReasonablePeRange(template);

  // monthly normalisation（FinMind RevenueRow → 我們的 schema）
  const monthlyHistory = monthly.map((r) => ({
    month: r.date,
    revenue: r.revenue,
    mom: null as number | null,
    yoy: null as number | null,
  }));
  // 補 mom/yoy
  for (let i = 0; i < monthlyHistory.length; i++) {
    const cur = monthlyHistory[i].revenue;
    const prev = monthlyHistory[i + 1]?.revenue;
    const yoyPrev = monthlyHistory[i + 12]?.revenue;
    if (prev && prev > 0) monthlyHistory[i].mom = (cur - prev) / prev;
    if (yoyPrev && yoyPrev > 0) monthlyHistory[i].yoy = (cur - yoyPrev) / yoyPrev;
  }

  const sourceUrls: Record<string, string> = {
    quote: `internal:/api/stock/quote?symbol=${symbol}`,
    quarterlyHistory: `finmind:TaiwanStockFinancialStatements?data_id=${ticker}`,
    monthlyRevenue: `finmind:TaiwanStockMonthRevenue?data_id=${ticker}`,
    sharesOutstanding: `finmind:TaiwanStockShareholding?data_id=${ticker}`,
    bookValuePerShare: `finmind:TaiwanStockBalanceSheet?data_id=${ticker}`,
    industry: stockInfo ? `finmind:TaiwanStockInfo?data_id=${ticker}` : 'candidate.industry',
  };

  return {
    market: 'TW',
    currentPrice,
    quarterlyHistory: quarterly.map((q) => ({
      quarter: q.quarter,
      revenue: q.revenue,
      grossProfit: q.grossProfit,
      netIncome: q.netIncome,
      eps: q.eps,
      netMargin: q.netMargin,
      grossMargin: q.grossMargin,
    })),
    monthlyRevenueHistory: monthlyHistory,
    sharesOutstanding: shares,
    bookValuePerShare: balance?.bookValuePerShare ?? null,
    ttmEps,
    ttmPe,
    dynamicPe,
    staticPe,
    lastYearTotalEps,
    dilutionEvents: dilution,
    industryTemplate: template,
    industryTemplateLabel: getTemplateLabel(template),
    reasonablePeRange: peRange,
    sourceUrls,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 陸股版（不抓月營收，用季度情境推估）
// ────────────────────────────────────────────────────────────────────────────

async function buildValuationInputsCN(
  symbol: string,
  industryHint: string | undefined,
  fetchErrors: string[],
): Promise<FundamentalGroundTruth['valuationInputs']> {
  const bare = symbol.replace(/\.(SS|SZ)$/i, '');

  const [quoteRaw, em] = await Promise.all([
    fetchJSON(internalUrl(`/api/stock/quote?symbol=${encodeURIComponent(symbol)}`))
      .catch((e) => { fetchErrors.push(`quote: ${e}`); return null; }),
    getEastMoneyFundamentals(symbol)
      .catch((e) => { fetchErrors.push(`emFundamentals: ${e}`); return null; }),
  ]);

  const quote = unwrapApi(quoteRaw) as { close?: number } | null;
  // 優先使用 quote API 的 close，fallback 用 EastMoney price
  const currentPrice = (typeof quote?.close === 'number' ? quote.close : null) ?? em?.price ?? null;

  // 陸股 quarterlyHistory MVP：先用 EastMoney 給的單季 EPS 當 quarterly[0]
  // 完整 8 季歷史要爬巨潮資訊，後續擴充
  const quarterlyHistory = em?.latestQuarterEps != null
    ? [{
        quarter: em.fetchedAt.slice(0, 10),
        revenue: null,
        grossProfit: null,
        netIncome: em.netIncome ?? null,
        nonRecurringNetIncome: null,
        eps: em.latestQuarterEps,
        netMargin: null,
        grossMargin: null,
      }]
    : [];

  // PE 計算優先用 EastMoney 的官方值（已是市場標準算法）
  const ttmPe = em?.ttmPe ?? null;
  const dynamicPe = em?.dynamicPe ?? (em?.latestQuarterEps && currentPrice
    ? computeDynamicPe(currentPrice, em.latestQuarterEps)
    : null);
  const staticPe = em?.staticPe ?? null;
  // 由 ttmPe 反推 ttmEps
  const ttmEps = ttmPe && currentPrice ? currentPrice / ttmPe : null;
  // 由 staticPe 反推去年全年 EPS
  const lastYearTotalEps = staticPe && currentPrice ? currentPrice / staticPe : null;

  // 產業模板 — 陸股目前只能用 industryHint
  const template = detectIndustryTemplate(industryHint);
  const peRange = getReasonablePeRange(template);

  const sourceUrls: Record<string, string> = {
    quote: `internal:/api/stock/quote?symbol=${symbol}`,
    eastmoney: em?.sourceUrl ?? `https://quote.eastmoney.com/concept/${bare}.html`,
  };

  return {
    market: 'CN',
    currentPrice,
    quarterlyHistory,
    monthlyRevenueHistory: [],  // 陸股不抓月營收
    sharesOutstanding: em?.totalShares ?? null,
    bookValuePerShare: em?.bookValuePerShare ?? null,
    ttmEps,
    ttmPe,
    dynamicPe,
    staticPe,
    lastYearTotalEps,
    dilutionEvents: [],  // 陸股增資公告後續擴充（巨潮資訊）
    industryTemplate: template,
    industryTemplateLabel: getTemplateLabel(template),
    reasonablePeRange: peRange,
    sourceUrls,
  };
}

function unwrapApi(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { ok?: boolean; data?: unknown };
  if (w.ok === true && w.data) return w.data;
  return raw;
}

// ────────────────────────────────────────────────────────────────────────────
// data/dilution/{symbol}.json — 由 MOPS scraper cron 寫入
// 格式：[{ type, newShares, expectedDate?, priceIfKnown?, sourceUrl?, announcedAt?, description? }]
// ────────────────────────────────────────────────────────────────────────────

interface DilutionFileEntry {
  type: 'gdr' | 'rights_issue' | 'convertible_bond' | 'employee_option' | 'private_placement';
  newShares: number;
  expectedDate?: string;
  priceIfKnown?: number;
  sourceUrl?: string;
  announcedAt?: string;
  description?: string;
}

async function readDilutionEvents(ticker: string): Promise<DilutionFileEntry[]> {
  const filePath = path.join(process.cwd(), 'data', 'dilution', `${ticker}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is DilutionFileEntry =>
      e && typeof e === 'object' && typeof e.type === 'string' && typeof e.newShares === 'number',
    );
  } catch {
    return [];
  }
}
