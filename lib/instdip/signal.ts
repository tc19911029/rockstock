/**
 * 「法人接刀」訊號 — 純函式（可回測、可掃描共用）
 *
 * isHit = (近 lookback 日在跌 或 今日長黑) 且 法人 lookback 日逆勢買超
 * 大戶持股「水位超高」的剔除是 cross-sectional（要全宇宙排名）→ 放掃描層處理，不在此純函式。
 */
import { InstDipParams, DEFAULT_PARAMS } from './types';

export interface Candle { date: string; open: number; close: number; volume: number }

export interface InstDipEval {
  date: string;
  price: number;
  drop5: number;     // 近 lookback 日漲跌%
  todayChg: number;  // 今日 收/開−1 %
  inst5K: number;    // 法人 lookback 日淨買超(張)
  isWeak: boolean;   // 在跌 或 長黑
  instBuy: boolean;  // 法人逆勢買超
  isHit: boolean;    // isWeak 且 instBuy
}

/**
 * 在 candles 第 t 根上評估訊號。
 * @param candles 升冪日K
 * @param instByDate date -> 三大法人合計買賣超(張)
 * @param t 要評估的日K index（需 t >= lookback）
 */
export function evaluateAt(
  candles: Candle[],
  instByDate: Map<string, number>,
  t: number,
  params: InstDipParams = DEFAULT_PARAMS,
): InstDipEval | null {
  const { lookback, dropMax, blackMax } = params;
  if (t < lookback || t >= candles.length) return null;
  const today = candles[t].date;
  if (!instByDate.has(today)) return null;

  let inst5 = 0;
  for (let k = t - (lookback - 1); k <= t; k++) {
    const dk = candles[k].date;
    if (!instByDate.has(dk)) return null; // 法人資料不齊 → 不評估
    inst5 += instByDate.get(dk)!;
  }

  const drop5 = (candles[t].close / candles[t - lookback].close - 1) * 100;
  const todayChg = candles[t].open > 0 ? (candles[t].close / candles[t].open - 1) * 100 : 0;
  const isWeak = drop5 < dropMax || todayChg < blackMax; // 在跌 或 長黑
  const instBuy = inst5 > 0;                              // 法人逆勢買

  return {
    date: today, price: candles[t].close,
    drop5, todayChg, inst5K: Math.round(inst5),
    isWeak, instBuy, isHit: isWeak && instBuy,
  };
}

/** 在最新一根有法人資料的日K上評估 */
export function evaluateLatest(
  candles: Candle[],
  instByDate: Map<string, number>,
  params: InstDipParams = DEFAULT_PARAMS,
): InstDipEval | null {
  for (let t = candles.length - 1; t >= params.lookback; t--) {
    if (instByDate.has(candles[t].date)) {
      return evaluateAt(candles, instByDate, t, params);
    }
  }
  return null;
}
