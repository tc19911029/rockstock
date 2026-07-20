/**
 * 陸股融資（兩融做多側）成本與平倉壓力價
 *
 * 與台股同一套數學（weightedCost），差在兩件事：
 *
 * 1. 單位：台股公布「融資增減張數」，陸股公布「融資餘額（元）」。
 *    融資餘額是「負債金額」、不隨股價浮動，所以
 *        當日新增股數 ≈ (今日 rzYe − 昨日 rzYe) ÷ 當日均價
 *    換成股數後丟進同一個 weightedCost()。
 *
 * 2. 斷頭口徑：陸股看「維持擔保比例 = 市值 / 融資負債」
 *        負債 = 成本 × 1/(1 + 融資保證金比例)
 *        平倉線 130%、警戒線 150%
 *    保證金比例 100%（交易所下限）→ 負債 = 0.5 × 成本
 *        → 平倉價 = 0.65 × 成本、警戒價 = 0.75 × 成本
 *
 * ⚠️ 這三個參數各家券商不同（實務常收得比交易所下限嚴），集中在 CN_MARGIN_PARAMS 一處可改。
 * ⚠️ 券商看的是「整戶」維持擔保比例，不是單一檔 → 此價僅壓力區參考。
 * ⚠️ 純顯示層，不進選股 gate（鐵則 #5）。
 */

import { fetchCnMarginHistory } from '@/lib/cn-agents/datasource/emMarginBalance';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { weightedCost, type Lot } from '@/lib/squeeze/costEstimator';
import type { MarginPressure } from './marginPressure';
import { distanceToLiquidation } from './marginPressure';

/** 陸股兩融參數（交易所下限；券商實務可能更嚴） */
export const CN_MARGIN_PARAMS = {
  /** 融資保證金比例（買 1 元需自備幾元）：100% = 槓桿 2 倍 */
  marginRequirementRatio: 1.0,
  /** 平倉（強平）線 */
  liquidationMaintenance: 1.3,
  /** 警戒（追保）線 */
  warningMaintenance: 1.5,
} as const;

/** 負債佔成本比例 = 1 / (1 + 保證金比例) */
export const CN_DEBT_RATIO = 1 / (1 + CN_MARGIN_PARAMS.marginRequirementRatio);

/** 兩融餘額抓幾筆（涵蓋 60 日窗口 + buffer） */
const HISTORY_SIZE = 90;

export interface CnMarginBalanceRow {
  date: string;
  /** 融資餘額（元） */
  rzYe: number;
}
export interface CnPriceRow {
  date: string;
  close: number;
  vwap: number;
}

/**
 * 陸股融資成本（純函式，供測試直接呼叫）
 *
 * 餘額（元）→ 每日新增股數 → weightedCost。d20 優先，缺值往其他窗口退。
 */
export function computeCnMarginCost(
  balances: CnMarginBalanceRow[],
  prices: CnPriceRow[],
): number | null {
  const priceMap = new Map<string, number>();
  for (const p of prices) priceMap.set(p.date, p.vwap);

  // 餘額（元）差分 ÷ 當日均價 → 當日新增股數。
  // 每個交易日都留一筆（含 ≤0 的減少日），slice(-n) 才是「近 n 個交易日」而非「近 n 個增加日」；
  // 負值由 weightedCost 內部過濾。
  const lots: Lot[] = [];
  for (let i = 1; i < balances.length; i++) {
    const deltaYuan = balances[i].rzYe - balances[i - 1].rzYe;
    const vwap = priceMap.get(balances[i].date);
    const shares = vwap && Number.isFinite(vwap) && vwap > 0 ? deltaYuan / vwap : 0;
    lots.push({ date: balances[i].date, lots: shares });
  }

  // d20 優先，缺值往 d10 → d5 → d60 退（與台股 refOfBucket 同順序）
  for (const n of [20, 10, 5, 60] as const) {
    const cost = weightedCost(lots.slice(-n), priceMap);
    if (cost !== null) return cost;
  }
  return null;
}

/** cost × 負債比例 × 維持率門檻（與台股 marginLiquidationPrice 同結構） */
export function cnLiquidationPrice(cost: number | null, maintenance: number): number | null {
  if (cost === null || !Number.isFinite(cost) || cost <= 0) return null;
  return +(cost * CN_DEBT_RATIO * maintenance).toFixed(2);
}

/**
 * 陸股日K → { date, close, vwap }；沒有成交金額欄位，vwap 用 (H+L+C)/3
 *
 * symbol 沒帶後綴（走圖/籌碼 API 常只給裸碼）時依序試 .SS/.SZ。
 */
async function loadCnPrices(symbol: string): Promise<CnPriceRow[]> {
  let file = null;
  if (/\.(SS|SZ)$/i.test(symbol)) {
    file = await readCandleFile(symbol, 'CN');
  } else {
    for (const suffix of ['SS', 'SZ'] as const) {
      file = await readCandleFile(`${symbol}.${suffix}`, 'CN');
      if (file) break;
    }
  }
  return (file?.candles ?? []).map(c => ({
    date: c.date,
    close: c.close,
    vwap: +((c.high + c.low + c.close) / 3).toFixed(4),
  }));
}

/** 陸股：單檔融資壓力（資料不足回 marginCost=null，呼叫端不顯示該行） */
export async function computeCnMarginPressure(symbol: string): Promise<MarginPressure> {
  const code = symbol.replace(/\.(SS|SZ|SH)$/i, '');

  const [balances, prices] = await Promise.all([
    fetchCnMarginHistory(code, HISTORY_SIZE),
    loadCnPrices(symbol),
  ]);

  const close = prices[prices.length - 1]?.close ?? 0;
  const marginCost = computeCnMarginCost(balances, prices);
  const liquidationPrice = cnLiquidationPrice(marginCost, CN_MARGIN_PARAMS.liquidationMaintenance);
  const marginCallPrice = cnLiquidationPrice(marginCost, CN_MARGIN_PARAMS.warningMaintenance);

  return {
    symbol,
    marginCost,
    marginCallPrice,
    liquidationPrice,
    releasePrice: null,   // 陸股無「解除追繳」對應制度（補到平倉線以上即可）
    close,
    distanceToLiquidationPct: distanceToLiquidation(close, liquidationPrice),
    marginRatio: CN_DEBT_RATIO,
    marginDays: balances.length,
  };
}
