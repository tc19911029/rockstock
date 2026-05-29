import type { QuarterRow } from './types';

export interface TTMResult {
  ttmEps: number;
  ttmRevenue: number;
  ttmNetIncome: number;
  ttmNetMargin: number;
  quartersUsed: number;
}

/**
 * 近四季 EPS / 營收 / 稅後淨利加總。
 * quarters 由近到遠或由遠到近皆可，本函數只取前 4 筆（已假設來源已排序）。
 */
export function computeTTM(quarters: QuarterRow[]): TTMResult | null {
  if (!quarters || quarters.length === 0) return null;
  const recent = quarters.slice(0, 4);
  if (recent.length < 4) return null;

  const ttmEps = recent.reduce((s, q) => s + (q.eps ?? 0), 0);
  const ttmRevenue = recent.reduce((s, q) => s + (q.revenue ?? 0), 0);
  const ttmNetIncome = recent.reduce((s, q) => s + (q.netIncome ?? 0), 0);
  const ttmNetMargin = ttmRevenue > 0 ? ttmNetIncome / ttmRevenue : 0;

  return {
    ttmEps,
    ttmRevenue,
    ttmNetIncome,
    ttmNetMargin,
    quartersUsed: recent.length,
  };
}

export function computeTTMPe(price: number, ttmEps: number): number {
  if (!ttmEps || ttmEps <= 0) return Number.POSITIVE_INFINITY;
  return price / ttmEps;
}

/**
 * 動態 PE（市盈率「動」）= 股價 /（最新一季 EPS × 4）
 * 假設最新一季獲利可以維持全年。陸股常用，台股當作補充指標。
 *
 * 警示：如果最新一季有一次性收益（處分利益 / 匯兌 / 政府補助），
 *       動態 PE 會過度樂觀 — skill prompt 內要做扣非檢查。
 */
export function computeDynamicPe(price: number, latestQuarterEps: number): number {
  if (!latestQuarterEps || latestQuarterEps <= 0) return Number.POSITIVE_INFINITY;
  return price / (latestQuarterEps * 4);
}

/**
 * 靜態 PE（市盈率「靜」）= 股價 / 去年全年 EPS
 * 陸股 App 常見欄位。用來判斷「最新一季 EPS 是否已大幅超越去年平均獲利速度」。
 */
export function computeStaticPe(price: number, lastYearTotalEps: number): number {
  if (!lastYearTotalEps || lastYearTotalEps <= 0) return Number.POSITIVE_INFINITY;
  return price / lastYearTotalEps;
}

/**
 * 用近 8 季資料推「去年全年 EPS」= quarters[4..7] 加總（前 4 季是今年，後 4 季是去年）。
 * 如果不滿 8 季，回 null。
 */
export function computeLastYearEps(quarters: QuarterRow[]): number | null {
  if (!quarters || quarters.length < 8) return null;
  const lastYear = quarters.slice(4, 8);
  return lastYear.reduce((s, q) => s + (q.eps ?? 0), 0);
}
