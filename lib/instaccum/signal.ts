/**
 * 「法人吸·融資退」訊號 — 純函式（可回測、可掃描共用）
 *
 * isHit = 股價沒大漲 + 融資大減 + 法人大買
 */
import { InstAccumParams, DEFAULT_PARAMS } from './types';

export interface Candle { date: string; close: number; volume: number }

export interface InstAccumEval {
  date: string;
  price: number;
  priceChg: number;        // 近 priceWin 日漲跌%
  marginChg: number;       // 融資餘額近 marginWin 日變化%
  marginBalance: number;   // 當日融資餘額(張)
  instSumK: number;        // 三大法人 instWin 日合計淨買超(張)
  instConsecDays: number;  // 三大法人合計連續買超天數
  instToVol: number;       // 法人 instWin 日買超佔成交量比%
  isPriceFlat: boolean;    // 條件1：沒大漲（在 [floor, maxRise] 之間）
  isMarginDropping: boolean; // 條件2：融資大減
  isInstBuying: boolean;   // 條件3：法人大買
  isHit: boolean;
}

/**
 * 在 candles 第 t 根上評估訊號。
 * @param candles 升冪日K（需含 close/volume）
 * @param instByDate  date -> 三大法人合計買賣超(張)
 * @param marginByDate date -> 融資餘額(張)
 * @param t 要評估的日K index
 *
 * 任一條件所需資料該日缺 → 回 null（不評估），同 Y 軌守衛（避免半套資料誤判）。
 */
export function evaluateAt(
  candles: Candle[],
  instByDate: Map<string, number>,
  marginByDate: Map<string, number>,
  t: number,
  params: InstAccumParams = DEFAULT_PARAMS,
): InstAccumEval | null {
  const { priceWin, priceMaxRisePct, priceFloorPct, marginWin, marginDropPct, instWin, instMode, instConsecMin, instToVolPct } = params;
  const need = Math.max(priceWin, marginWin, instWin);
  if (t < need || t >= candles.length) return null;

  // 條件1：沒大漲（近 priceWin 日漲幅在 [floor, maxRise] 之間）
  const c0 = candles[t - priceWin]?.close;
  const cT = candles[t]?.close;
  if (!(c0 > 0) || !(cT > 0)) return null;
  const priceChg = (cT / c0 - 1) * 100;
  const isPriceFlat = priceChg <= priceMaxRisePct && priceChg >= priceFloorPct;

  // 條件2：融資大減（融資餘額較 marginWin 日前變化 ≤ marginDropPct%）
  // marginByDate 在 t 與 t-marginWin 兩個交易日都要有值，否則不評估。
  const dateT = candles[t].date;
  const dateW = candles[t - marginWin].date;
  const mT = marginByDate.get(dateT);
  const mW = marginByDate.get(dateW);
  if (mT == null || mW == null || !(mW > 0)) return null;
  const marginChg = (mT / mW - 1) * 100;
  const isMarginDropping = marginChg <= marginDropPct;

  // 條件3：法人大買（instWin 日每日都要有 inst 值）
  let instSum = 0, volSum = 0;
  for (let k = t - (instWin - 1); k <= t; k++) {
    const dk = candles[k].date;
    if (!instByDate.has(dk)) return null;
    instSum += instByDate.get(dk)!;
    volSum += candles[k].volume || 0;
  }
  let instConsecDays = 0;
  for (let k = t; k >= 0; k--) {
    const dk = candles[k].date;
    if (!instByDate.has(dk)) break;
    if ((instByDate.get(dk) ?? 0) > 0) instConsecDays++;
    else break;
  }
  const instToVol = volSum > 0 ? (instSum / volSum) * 100 : 0;
  const isInstBuying = instMode === 'consec'
    ? (instSum > 0 && instConsecDays >= instConsecMin)
    : (instSum > 0 && instToVol >= instToVolPct);

  return {
    date: dateT,
    price: cT,
    priceChg: +priceChg.toFixed(2),
    marginChg: +marginChg.toFixed(2),
    marginBalance: Math.round(mT),
    instSumK: Math.round(instSum),
    instConsecDays,
    instToVol: +instToVol.toFixed(2),
    isPriceFlat,
    isMarginDropping,
    isInstBuying,
    isHit: isPriceFlat && isMarginDropping && isInstBuying,
  };
}

/** 在最新一根同時有法人 + 融資資料的日K上評估 */
export function evaluateLatest(
  candles: Candle[],
  instByDate: Map<string, number>,
  marginByDate: Map<string, number>,
  params: InstAccumParams = DEFAULT_PARAMS,
): InstAccumEval | null {
  const need = Math.max(params.priceWin, params.marginWin, params.instWin);
  for (let t = candles.length - 1; t >= need; t--) {
    const d = candles[t].date;
    if (instByDate.has(d) && marginByDate.has(d)) {
      return evaluateAt(candles, instByDate, marginByDate, t, params);
    }
  }
  return null;
}
