/**
 * 融資斷頭壓力（輕量版）— 給 /portfolio 持股卡批量呼叫用
 *
 * 與 getCostBasisBundle() 的差別：後者一次讀 margin/sbl/prices/法人/分點 5 份資料，
 * 10 檔持股一起跑太重。這裡只走「融資」這一條線（margin + prices 兩份）。
 *
 * 數學完全共用既有單一事實來源：
 *   融資成本 = computeMarginLongCosts()（weightedCost：Σ(當日融資淨增張數 × 當日VWAP) ÷ Σ淨增張數）
 *   斷頭/追繳價 = marginLiquidationPrice()
 *
 * ⚠️ 純顯示層，不進選股 gate（鐵則 #5）。
 */

import path from 'path';
import { promises as fs } from 'fs';
import { getMarginSeries, getPriceSeries } from '@/lib/squeeze/dataLoader';
import { computeMarginLongCosts } from './marginLongCost';
import {
  marginLiquidationPrice,
  MARGIN_CALL_MAINTENANCE,
  MARGIN_RATIO_LISTED,
  MARGIN_RATIO_OTC,
} from './marginLiquidationPrice';
import type { CostBucket } from './types';

/** 抓 ~90 交易日（涵蓋 60d 窗口 + buffer） */
const LOOKBACK_CALENDAR_DAYS = 130;

/** 單檔融資壓力摘要（台股 / 陸股共用形狀） */
export interface MarginPressure {
  symbol: string;
  /** 融資（多方）加權平均成本估算 */
  marginCost: number | null;
  /** 追繳警戒價 */
  marginCallPrice: number | null;
  /** 斷頭價 */
  liquidationPrice: number | null;
  /** 最新收盤 */
  close: number;
  /** 現價距斷頭價 %（正=現價在斷頭價之上、有緩衝；負=已跌破） */
  distanceToLiquidationPct: number | null;
  /** 融資成數（台股 0.6/0.5；陸股用負債比例） */
  marginRatio: number;
  /** 資料天數（揭露用） */
  marginDays: number;
}

/** d20 優先，缺值往其他窗口退 */
export function refOfBucket(b: CostBucket): number | null {
  return b.d20 ?? b.d10 ?? b.d5 ?? b.d60 ?? null;
}

/**
 * 融資成數：明確 .TWO 或本地有 .TWO 日K（symbol 可能被誤標 .TW）→ 上櫃 0.5，否則上市 0.6
 *
 * 單一事實來源：aggregate.ts 也 import 這支，不可另寫一份。
 */
export async function detectMarginRatio(code: string, symbol: string): Promise<number> {
  if (/\.TWO$/i.test(symbol)) return MARGIN_RATIO_OTC;
  try {
    await fs.access(path.join(process.cwd(), 'data', 'candles', 'TW', `${code}.TWO.json`));
    return MARGIN_RATIO_OTC;
  } catch {
    return MARGIN_RATIO_LISTED;
  }
}

export function ymdDaysAgo(end: string, days: number): string {
  const d = new Date(end + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** 現價距斷頭價 %（正=還有緩衝） */
export function distanceToLiquidation(close: number, liqPrice: number | null): number | null {
  if (liqPrice === null || close <= 0) return null;
  return +(((close - liqPrice) / close) * 100).toFixed(2);
}

/** 台股：單檔融資壓力（資料不足回 marginCost=null，呼叫端不顯示該行） */
export async function computeTwMarginPressure(symbol: string, asOfDate: string): Promise<MarginPressure> {
  const code = symbol.replace(/\.(TW|TWO)$/i, '');
  const startDate = ymdDaysAgo(asOfDate, LOOKBACK_CALENDAR_DAYS);

  const [margin, prices, ratio] = await Promise.all([
    getMarginSeries(code, startDate, asOfDate),
    getPriceSeries(code, startDate, asOfDate),
    detectMarginRatio(code, symbol),
  ]);

  const close = prices[prices.length - 1]?.close ?? 0;
  const marginCost = refOfBucket(computeMarginLongCosts(margin, prices));
  const liquidationPrice = marginLiquidationPrice(marginCost, ratio);
  const marginCallPrice = marginLiquidationPrice(marginCost, ratio, MARGIN_CALL_MAINTENANCE);

  return {
    symbol,
    marginCost,
    marginCallPrice,
    liquidationPrice,
    close,
    distanceToLiquidationPct: distanceToLiquidation(close, liquidationPrice),
    marginRatio: ratio,
    marginDays: margin.length,
  };
}
