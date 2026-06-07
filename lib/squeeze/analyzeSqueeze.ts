/**
 * Entry point：analyzeSqueeze(code, asOfDate) → SqueezeAnalysis
 *
 *   1. 拉 60+ 個交易日的 margin / sbl / price 範圍資料（含 cache）
 *   2. 算 5/10/20/60d 加權空方成本（融券/借券/綜合）
 *   3. 算融券追繳壓力價
 *   4. 算 5x20=100 軋空壓力分數
 *   5. 規則式產文字解讀
 */

import type { SqueezeAnalysis } from './types';
import { getMarginSeries, getSblSeries, getPriceSeries } from './dataLoader';
import { computeShortCosts } from './costEstimator';
import { computeSqueezeScore } from './squeezeScorer';
import { marginCallPrice } from './marginCallPrice';
import { buildInterpretation, buildWarnings } from './narrator';

// 抓 90 個交易日（covers 60d window + buffer）
const LOOKBACK_CALENDAR_DAYS = 130;

function ymdDaysAgo(end: string, days: number): string {
  const d = new Date(end + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function loadStockName(symbol: string): Promise<string> {
  try {
    // Blob-aware：本地讀檔、Vercel 讀 Blob（stock-master 已 dual-store 於 youtube/ prefix）
    const { loadStockMaster } = await import('@/lib/youtube/stockMaster');
    const master = await loadStockMaster();
    return master.entries.find(e => e.code === symbol)?.name ?? symbol;
  } catch {
    return symbol;
  }
}

function balChange(arr: number[], n: number): number {
  if (arr.length < n + 1) return 0;
  return arr[arr.length - 1] - arr[arr.length - 1 - n];
}

export async function analyzeSqueeze(symbol: string, asOfDate: string): Promise<SqueezeAnalysis> {
  const startDate = ymdDaysAgo(asOfDate, LOOKBACK_CALENDAR_DAYS);
  const [margin, sbl, prices, name] = await Promise.all([
    getMarginSeries(symbol, startDate, asOfDate),
    getSblSeries(symbol, startDate, asOfDate),
    getPriceSeries(symbol, startDate, asOfDate),
    loadStockName(symbol),
  ]);

  const lastPrice = prices[prices.length - 1];
  const close = lastPrice?.close ?? 0;

  const shortCosts = computeShortCosts(margin, sbl, prices);
  const combined = shortCosts.combined;
  const refCost = combined.d20 ?? combined.d10 ?? combined.d5 ?? combined.d60 ?? null;
  const callPrice = marginCallPrice(refCost);
  const distToCallPct = callPrice && close > 0 ? +(((callPrice - close) / close) * 100).toFixed(2) : null;

  const score = computeSqueezeScore({
    margin, sbl, prices,
    shortCosts,
    marginCallPrice: callPrice,
    close,
  });

  const vsCostPct: SqueezeAnalysis['vsCostPct'] = {
    d5:  combined.d5  ? +(((close - combined.d5)  / combined.d5)  * 100).toFixed(2) : null,
    d10: combined.d10 ? +(((close - combined.d10) / combined.d10) * 100).toFixed(2) : null,
    d20: combined.d20 ? +(((close - combined.d20) / combined.d20) * 100).toFixed(2) : null,
    d60: combined.d60 ? +(((close - combined.d60) / combined.d60) * 100).toFixed(2) : null,
  };

  const shortBalSeries = margin.map(m => m.shortBalance);
  const sblBalSeries = sbl.map(s => s.lendingBalance);

  const result: SqueezeAnalysis = {
    symbol,
    name,
    asOfDate,
    close,
    shortCosts,
    vsCostPct,
    marginBalance: margin[margin.length - 1]?.marginBalance ?? 0,
    shortBalance: margin[margin.length - 1]?.shortBalance ?? 0,
    shortBalanceChange5d: balChange(shortBalSeries, 5),
    shortBalanceChange20d: balChange(shortBalSeries, 20),
    lendingBalance: sbl[sbl.length - 1]?.lendingBalance ?? 0,
    lendingBalanceChange5d: balChange(sblBalSeries, 5),
    lendingBalanceChange20d: balChange(sblBalSeries, 20),
    marginCallPrice: callPrice,
    distanceToMarginCallPct: distToCallPct,
    score,
    interpretation: '',
    warnings: buildWarnings(),
    dataCompleteness: {
      marginDays: margin.length,
      sblDays: sbl.length,
      priceDays: prices.length,
    },
  };
  result.interpretation = buildInterpretation(result);
  return result;
}
