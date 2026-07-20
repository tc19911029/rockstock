/**
 * getCostBasisBundle(symbol, asOfDate) → 一次組出 9 項「成本／壓力價」
 *
 *   #1 外資 / #2 投信 / #3 自營商   ← computeInstCosts（readInstStock）
 *   #4 主力                          ← computeBrokerCosts（BrokerStorage，歷史累積）
 *   #5 融資                          ← computeMarginLongCosts（marginNet）
 *   #6 融券 / #7 券賣 / #8 嘎空價    ← computeShortCosts + marginCallPrice（reuse squeeze）
 *   #9 融資斷頭價                    ← marginLiquidationPrice
 */

import path from 'path';
import { promises as fs } from 'fs';
import { getMarginSeries, getSblSeries, getPriceSeries } from '@/lib/squeeze/dataLoader';
import { computeShortCosts } from '@/lib/squeeze/costEstimator';
import { marginCallPrice } from '@/lib/squeeze/marginCallPrice';
import { readInstStock } from '@/lib/chips/ChipStorage';
import { readBrokerStock } from '@/lib/chips/BrokerStorage';
import { computeInstCosts } from './instCost';
import { computeMarginLongCosts } from './marginLongCost';
import { computeBrokerCosts, brokerCostStatus } from './brokerCost';
import { computeMainForceCompositeCosts } from './mainForceCost';
import type { BrokerCostMethod } from './types';
import {
  marginLiquidationPrice,
  MARGIN_CALL_MAINTENANCE,
} from './marginLiquidationPrice';
import { computeMarginLiquidationScore } from './marginLiquidationScorer';
import { detectMarginRatio } from './marginPressure';
import { buildMarginInterpretation, buildMarginWarnings } from './narrator';
import type { CostBasisBundle, CostBucket, CostBasisSummary } from './types';
import { EMPTY_BUCKET } from './types';

// 抓 ~90 交易日（covers 60d window + buffer）
const LOOKBACK_CALENDAR_DAYS = 130;

function ymdDaysAgo(end: string, days: number): string {
  const d = new Date(end + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function loadStockName(code: string): Promise<string> {
  try {
    const p = path.join(process.cwd(), 'data', 'youtube', 'stock-master.json');
    const d = JSON.parse(await fs.readFile(p, 'utf8')) as { entries: Array<{ code: string; name: string }> };
    return d.entries.find(e => e.code === code)?.name ?? code;
  } catch {
    return code;
  }
}

function balChange(arr: number[], n: number): number {
  if (arr.length < n + 1) return 0;
  return arr[arr.length - 1] - arr[arr.length - 1 - n];
}

/** d20 成本相對現價 %（正=現價在成本之上） */
function vsClose(bucket: CostBucket, close: number): number | null {
  const cost = bucket.d20 ?? bucket.d10 ?? bucket.d5 ?? bucket.d60 ?? null;
  if (cost === null || cost <= 0 || close <= 0) return null;
  return +(((close - cost) / cost) * 100).toFixed(2);
}

const refOf = (b: CostBucket): number | null => b.d20 ?? b.d10 ?? b.d5 ?? b.d60 ?? null;

// 融資成數判定（上市 0.6 / 上櫃 0.5）單一事實來源在 marginPressure.ts

export async function getCostBasisBundle(symbol: string, asOfDate: string): Promise<CostBasisBundle> {
  const code = symbol.replace(/\.(TW|TWO)$/i, '');
  const startDate = ymdDaysAgo(asOfDate, LOOKBACK_CALENDAR_DAYS);

  const [margin, sbl, prices, instFile, brokerFile, name] = await Promise.all([
    getMarginSeries(code, startDate, asOfDate),
    getSblSeries(code, startDate, asOfDate),
    getPriceSeries(code, startDate, asOfDate),
    readInstStock(code),
    readBrokerStock(code),
    loadStockName(code),
  ]);

  const close = prices[prices.length - 1]?.close ?? 0;
  const inst = (instFile?.data ?? []).filter(r => r.date >= startDate && r.date <= asOfDate);
  const brokerDays = (brokerFile?.data ?? []).filter(r => r.date >= startDate && r.date <= asOfDate);

  // ── #6/#7 空方成本 + #8 嘎空價（reuse squeeze 引擎）──
  const shortCosts = computeShortCosts(margin, sbl, prices);
  const squeezePrice = marginCallPrice(refOf(shortCosts.combined));

  // ── #5 融資成本 + #9 斷頭/追繳價 ──
  const marginCosts = computeMarginLongCosts(margin, prices);
  const refMargin = refOf(marginCosts);
  const ratio = await detectMarginRatio(code, symbol);
  const liqPrice = marginLiquidationPrice(refMargin, ratio);                              // 130%
  const callPrice140 = marginLiquidationPrice(refMargin, ratio, MARGIN_CALL_MAINTENANCE); // 140%
  const distToLiq = liqPrice !== null && close > 0
    ? +(((close - liqPrice) / close) * 100).toFixed(2)   // 正=現價在斷頭價之上、有緩衝
    : null;

  // ── #1/#2/#3 法人成本 ──
  const instCosts = computeInstCosts(inst, prices);

  // ── #4 主力成本 ──
  // 真分點歷史(Yahoo cron 累積 ≥20 日) 優先；不足時用「主力綜合」合成估算(可立即回推)。
  const brokerStatus = brokerCostStatus(brokerDays.length);
  const branchCosts = brokerStatus === 'ok' ? computeBrokerCosts(brokerDays, prices) : null;
  const compositeCosts = computeMainForceCompositeCosts(inst, margin, sbl, prices);
  let brokerBucket: CostBucket;
  let brokerCostMethod: BrokerCostMethod;
  if (branchCosts && refOf(branchCosts) !== null) {
    brokerBucket = branchCosts;
    brokerCostMethod = 'branch';
  } else if (refOf(compositeCosts) !== null) {
    brokerBucket = compositeCosts;
    brokerCostMethod = 'composite';
  } else {
    brokerBucket = { ...EMPTY_BUCKET };
    brokerCostMethod = 'none';
  }

  const costs = {
    foreign: instCosts.foreign,
    trust: instCosts.trust,
    dealer: instCosts.dealer,
    broker: brokerBucket,
    margin: marginCosts,
    short: shortCosts.margin,
    sbl: shortCosts.sbl,
  };

  // ── 融資斷頭壓力分數 + 解讀 ──
  const marginBal = margin.map(m => m.marginBalance);
  const score = computeMarginLiquidationScore({
    margin, prices, marginCosts, liquidationPrice: liqPrice, close,
  });
  const interpretation = buildMarginInterpretation({
    close,
    marginCost: marginCosts,
    marginBalance: margin[margin.length - 1]?.marginBalance ?? 0,
    marginBalanceChange5d: balChange(marginBal, 5),
    marginUtilRate: margin[margin.length - 1]?.marginUtilRate ?? 0,
    liquidationPrice: liqPrice,
    marginCallPrice140: callPrice140,
    distanceToLiquidationPct: distToLiq,
    level: score.level,
  });

  return {
    symbol: code,
    name,
    asOfDate,
    close,
    costs,
    vsClosePct: {
      foreign: vsClose(costs.foreign, close),
      trust: vsClose(costs.trust, close),
      dealer: vsClose(costs.dealer, close),
      broker: vsClose(costs.broker, close),
      margin: vsClose(costs.margin, close),
      short: vsClose(costs.short, close),
      sbl: vsClose(costs.sbl, close),
    },
    squeezePrice,
    marginLiquidationPrice: liqPrice,
    marginCallPrice140: callPrice140,
    distanceToLiquidationPct: distToLiq,
    marginScore: score,
    interpretation,
    warnings: buildMarginWarnings(),
    marginRatio: ratio,
    brokerStatus,
    brokerCostMethod,
    dataCompleteness: {
      instDays: inst.length,
      marginDays: margin.length,
      brokerDays: brokerDays.length,
      priceDays: prices.length,
    },
  };
}

/** 從完整 bundle 萃取首頁籌碼 tab 用的精簡摘要 */
export function toCostBasisSummary(b: CostBasisBundle): CostBasisSummary {
  return {
    foreignCost: refOf(b.costs.foreign),
    trustCost: refOf(b.costs.trust),
    dealerCost: refOf(b.costs.dealer),
    brokerCost: refOf(b.costs.broker),
    marginCost: refOf(b.costs.margin),
    shortCost: refOf(b.costs.short),
    sblCost: refOf(b.costs.sbl),
    squeezePrice: b.squeezePrice,
    marginLiquidationPrice: b.marginLiquidationPrice,
    distanceToLiquidationPct: b.distanceToLiquidationPct,
    brokerStatus: b.brokerStatus,
    brokerCostMethod: b.brokerCostMethod,
  };
}
