/**
 * 「主力分點剛開始偷買」訊號 — 純函式（可回測、可掃描共用，refined 版）
 *
 * isHit = 主力分點 longWin 日集中度「由負轉正」+ 落在 [longMin,longMax]
 *         + shortWin 日集中度 < shortMax（濾隔日沖）+ 量比 < volRatioMax（不爆量）
 */
import { SmartMoneyParams, DEFAULT_PARAMS } from './types';

export interface Candle { date: string; close: number; volume: number }

export interface SmartMoneyEval {
  date: string;
  price: number;
  conc20: number;      // 主力分點 longWin 日集中度%
  conc20prev: number;  // turnBack 日前的 longWin 日集中度%
  conc5: number;       // 主力分點 shortWin 日集中度%
  volRatio: number;    // 今日量 ÷ 20日均量
  drop5: number;       // 近 shortWin 日漲跌%（顯示用）
  isHit: boolean;      // 是否同時滿足 refined 全部條件
}

/** 在 candles 第 t 根算「結束於 t、長度 w」的主力分點集中度%。
 *  容許視窗內少數天缺 broker（只加總在場天的淨額÷量，需 ≥60% 天在場才回值）。
 *  同 lib/inststeal/signal 的容缺理由：Yahoo 券商分點無歷史，某天 snapshot cron 漏跑＝永久洞，
 *  「缺一天整段回 null」會讓那洞污染 W 軌 longWin(20) 日視窗、拖垮之後約 20 個交易日的掃描。 */
function concentration(
  candles: Candle[],
  brokerByDate: Map<string, number>,
  t: number,
  w: number,
): number | null {
  if (t - w + 1 < 0) return null;
  let net = 0, vol = 0, present = 0;
  for (let k = t - w + 1; k <= t; k++) {
    const dk = candles[k].date;
    if (!brokerByDate.has(dk)) continue; // 缺該日 → 跳過，不整段作廢
    net += brokerByDate.get(dk)!;
    vol += candles[k].volume || 0;
    present++;
  }
  if (present < Math.ceil(w * 0.6)) return null; // 在場天數太少 → 不可信
  if (vol <= 0) return null;
  return (net / vol) * 100; // 兩者皆「張」，不可再 ×1000
}

/**
 * 在 candles 第 t 根上評估 refined 訊號。
 * @param candles 升冪日K
 * @param brokerByDate date -> 主力分點(前15大券商)淨買賣超(張)
 * @param t 要評估的日K index
 */
export function evaluateAt(
  candles: Candle[],
  brokerByDate: Map<string, number>,
  t: number,
  params: SmartMoneyParams = DEFAULT_PARAMS,
): SmartMoneyEval | null {
  const { shortWin, longWin, turnBack, longMin, longMax, shortMax, volRatioMax } = params;
  const need = longWin + turnBack; // 算 turnBack 日前的 longWin 集中度要往回 longWin+turnBack
  if (t < need || t >= candles.length) return null;
  if (!brokerByDate.has(candles[t].date)) return null;

  const conc20 = concentration(candles, brokerByDate, t, longWin);
  const conc20prev = concentration(candles, brokerByDate, t - turnBack, longWin);
  const conc5 = concentration(candles, brokerByDate, t, shortWin);
  if (conc20 == null || conc20prev == null || conc5 == null) return null;

  let v20 = 0;
  for (let k = t - 19; k <= t; k++) v20 += candles[k].volume || 0;
  const volRatio = v20 > 0 ? (candles[t].volume || 0) / (v20 / 20) : 0;
  const drop5 = (candles[t].close / candles[t - shortWin].close - 1) * 100;

  const isHit =
    conc20 > 0 && conc20prev <= 0 &&        // 由負轉正：剛開始吃貨
    conc20 >= longMin && conc20 <= longMax && // 落在合理區間（太高=已吃完）
    conc5 < shortMax &&                       // 濾隔日沖假象
    volRatio < volRatioMax;                   // 不爆量

  return {
    date: candles[t].date,
    price: candles[t].close,
    conc20: +conc20.toFixed(2),
    conc20prev: +conc20prev.toFixed(2),
    conc5: +conc5.toFixed(2),
    volRatio: +volRatio.toFixed(2),
    drop5,
    isHit,
  };
}

/** 在最新一根有主力分點資料的日K上評估 */
export function evaluateLatest(
  candles: Candle[],
  brokerByDate: Map<string, number>,
  params: SmartMoneyParams = DEFAULT_PARAMS,
): SmartMoneyEval | null {
  const need = params.longWin + params.turnBack;
  for (let t = candles.length - 1; t >= need; t--) {
    if (brokerByDate.has(candles[t].date)) {
      return evaluateAt(candles, brokerByDate, t, params);
    }
  }
  return null;
}
