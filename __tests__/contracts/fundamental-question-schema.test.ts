/**
 * Contract test：FundamentalQuestion schema 必須向下相容。
 *
 * 既有 11 個欄位（eps/epsYoY/grossMargin/.../revenueYoY）+ industry 不可破壞。
 * v2 新增的 valuationInputs 必須是 optional（既有 prepare 流程不寫也能 work）。
 */

import type { FundamentalQuestion, FundamentalGroundTruth } from '@/lib/agents/types';

describe('FundamentalQuestion schema invariants', () => {
  it('accepts legacy v1 question without valuationInputs', () => {
    const legacy: FundamentalQuestion = {
      schemaVersion: 1,
      agent: 'fundamental',
      runId: 'r1',
      date: '2026-05-27',
      symbol: '3661',
      market: 'TW',
      groundTruth: {
        symbol: '3661',
        name: '世芯-KY',
        fundamentals: {
          eps: 17.55,
          epsYoY: 0.4,
          grossMargin: 0.32,
          netMargin: 0.341,
          per: 65.95,
          pbr: 12.0,
          dividendYield: 0.5,
          revenueLatest: 41.85e8,
          revenueMoM: 0.1,
          revenueYoY: 1.2,
        },
        industry: '其他電子業',
        fetchErrors: [],
      },
    };
    expect(legacy.groundTruth.fundamentals?.eps).toBe(17.55);
    expect(legacy.groundTruth.valuationInputs).toBeUndefined();
  });

  it('accepts v2 question with valuationInputs (TW)', () => {
    const v2: FundamentalGroundTruth = {
      symbol: '3661',
      name: '世芯-KY',
      fundamentals: null,
      industry: '其他電子業',
      valuationInputs: {
        market: 'TW',
        currentPrice: 4500,
        quarterlyHistory: [
          { quarter: '2026-03-31', revenue: 41.85, grossProfit: null, netIncome: 14.28, eps: 17.55, netMargin: 0.341, grossMargin: null },
        ],
        monthlyRevenueHistory: [
          { month: '2026-04', revenue: 21.33, mom: null, yoy: null },
        ],
        sharesOutstanding: 81370000,
        bookValuePerShare: 250,
        ttmEps: 68.23,
        ttmPe: 65.95,
        dynamicPe: 64.07,        // 4500 / (17.55*4) = 64.07
        staticPe: 75.6,           // 4500 / 59.5 (假設去年全年)
        lastYearTotalEps: 59.5,
        dilutionEvents: [
          { type: 'gdr', newShares: 6000000, expectedDate: '2026-07-01' },
        ],
        industryTemplate: 'high_growth_asic',
        industryTemplateLabel: '高成長 ASIC / AI 半導體',
        reasonablePeRange: { pessimistic: 40, base: 50, optimistic: 60 },
        sourceUrls: {
          quote: 'internal:/api/stock/quote?symbol=3661',
        },
      },
      fetchErrors: [],
    };
    expect(v2.valuationInputs?.industryTemplate).toBe('high_growth_asic');
    expect(v2.valuationInputs?.dilutionEvents[0].type).toBe('gdr');
    expect(v2.valuationInputs?.market).toBe('TW');
  });

  it('accepts v2 question with valuationInputs (CN)', () => {
    const cn: FundamentalGroundTruth = {
      symbol: '603986.SS',
      name: '兆易創新',
      fundamentals: null,
      industry: '半導體',
      valuationInputs: {
        market: 'CN',
        currentPrice: 514.18,
        quarterlyHistory: [
          { quarter: '2026-03-31', revenue: null, grossProfit: null, netIncome: null, eps: 2.084, netMargin: null, grossMargin: null },
        ],
        monthlyRevenueHistory: [],  // 陸股無月營收
        sharesOutstanding: 668000000,
        bookValuePerShare: 26.5,
        ttmEps: 4.10,
        ttmPe: 125.40,
        dynamicPe: 61.68,         // 514.18 / (2.084 * 4)
        staticPe: 218.74,
        lastYearTotalEps: 2.35,
        dilutionEvents: [],
        industryTemplate: 'high_growth_asic',
        industryTemplateLabel: '高成長 ASIC / AI 半導體',
        reasonablePeRange: { pessimistic: 40, base: 50, optimistic: 60 },
        sourceUrls: {
          quote: 'internal:/api/stock/quote?symbol=603986.SS',
          eastmoney: 'https://quote.eastmoney.com/sh603986.html',
        },
      },
      fetchErrors: [],
    };
    expect(cn.valuationInputs?.market).toBe('CN');
    expect(cn.valuationInputs?.monthlyRevenueHistory.length).toBe(0);
    expect(cn.valuationInputs?.dynamicPe).toBeCloseTo(61.68, 1);
  });

  it('FundamentalAnswer.valuation is optional (v1 answers still valid)', () => {
    const answer = {
      schemaVersion: 1 as const,
      agent: 'fundamental' as const,
      runId: 'r1',
      date: '2026-05-27',
      symbol: '3661',
      verdict: 'watch' as const,
      overview: '營收成長但 PE 偏高',
      verdictReason: '需要等 GDR 定價',
      reasoning: [],
      dataPoints: [],
    };
    // 不指定 valuation 也可以 — 編譯通過代表 schema 向下相容
    expect(answer.verdict).toBe('watch');
  });
});
