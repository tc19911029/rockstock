/**
 * 「法人偷買(原)」訊號 — 純函式（可回測、可掃描共用）
 *
 * isHit = 股價在跌 + 5日籌碼集中度慢慢增加 + 法人陸續買進
 */
import { InstStealParams, DEFAULT_PARAMS } from './types';

export interface Candle { date: string; close: number; volume: number }

export interface InstStealEval {
  date: string;
  price: number;
  drop5: number;          // 近 dropWin 日漲跌%
  conc5: number;          // 主力分點 concWin 日集中度%
  conc5prev: number;      // concRiseBack 日前的 concWin 日集中度%
  volRatio: number;       // 今日量 ÷ 20日均量
  instSumK: number;       // 三大法人 instWin 日合計淨買超(張)
  instConsecDays: number; // 三大法人合計連續買超天數
  isDropping: boolean;    // 條件1：在跌
  isConcRising: boolean;  // 條件2：集中度慢慢增加
  isInstBuying: boolean;  // 條件3：法人陸續買進
  isHit: boolean;
}

/** 在 candles 第 t 根算「結束於 t、長度 w」的主力分點集中度%（資料不齊回 null） */
function concentration(
  candles: Candle[],
  brokerByDate: Map<string, number>,
  t: number,
  w: number,
): number | null {
  if (t - w + 1 < 0) return null;
  let net = 0, vol = 0;
  for (let k = t - w + 1; k <= t; k++) {
    const dk = candles[k].date;
    if (!brokerByDate.has(dk)) return null;
    net += brokerByDate.get(dk)!;
    vol += candles[k].volume || 0;
  }
  if (vol <= 0) return null;
  return (net / vol) * 100; // 兩者皆「張」，不可再 ×1000
}

/**
 * 在 candles 第 t 根上評估訊號。
 * @param candles 升冪日K
 * @param brokerByDate date -> 主力分點(前15大券商)淨買賣超(張)
 * @param instByDate  date -> 三大法人合計買賣超(張)
 * @param t 要評估的日K index
 */
export function evaluateAt(
  candles: Candle[],
  brokerByDate: Map<string, number>,
  instByDate: Map<string, number>,
  t: number,
  params: InstStealParams = DEFAULT_PARAMS,
  /** 跟看盤 app 對齊的「正式集中度」(FinMind 區間前15排名)。給了就用它(統一條件面板/掃描/顯示)，
   *  不給則退回主力分點淨額÷量的簡化版(向下相容、回測舊資料用)。 */
  conc5ByDate?: Map<string, number | null>,
  /** 嚴格模式（掃描用）：conc5ByDate 該日缺 FinMind 值 → 直接略過該股（回 null），
   *  不退回簡化版（避免「FinMind 限流時靜默選到舊公式的股」）。條件面板走圖往回看用 false。 */
  strictConc = false,
): InstStealEval | null {
  const { dropWin, dropMax, concWin, concRiseBack, concCap, volRatioMax, instWin, instConsecMin, concRequirePositive } = params;
  // 往回需要：concWin + concRiseBack（算 concRiseBack 日前的集中度）、20（量比）、dropWin、instWin
  const need = Math.max(concWin + concRiseBack, 20, dropWin, instWin);
  if (t < need || t >= candles.length) return null;

  // 集中度：優先 FinMind 正式公式（跟看盤 app + 顯示表統一）。strict=該日缺就 null；
  // 非 strict 才退回主力分點淨額÷量的簡化版（走圖往回看超出 FinMind 視窗 / 回測舊資料）。
  const fmConc5 = conc5ByDate?.get(candles[t].date);
  const fmConc5prev = conc5ByDate?.get(candles[t - concRiseBack].date);
  const noFallback = strictConc && !!conc5ByDate;
  const conc5 = fmConc5 != null ? fmConc5 : (noFallback ? null : concentration(candles, brokerByDate, t, concWin));
  const conc5prev = fmConc5prev != null ? fmConc5prev : (noFallback ? null : concentration(candles, brokerByDate, t - concRiseBack, concWin));
  if (conc5 == null || conc5prev == null) return null;

  // 法人 instWin 日合計淨買超 + 連買天數（資料任一日缺 → 不評估）
  let instSum = 0;
  for (let k = t - (instWin - 1); k <= t; k++) {
    const dk = candles[k].date;
    if (!instByDate.has(dk)) return null;
    instSum += instByDate.get(dk)!;
  }
  let instConsecDays = 0;
  for (let k = t; k >= 0; k--) {
    const dk = candles[k].date;
    if (!instByDate.has(dk)) break;
    if ((instByDate.get(dk) ?? 0) > 0) instConsecDays++;
    else break;
  }

  let v20 = 0;
  for (let k = t - 19; k <= t; k++) v20 += candles[k].volume || 0;
  const volRatio = v20 > 0 ? (candles[t].volume || 0) / (v20 / 20) : 0;
  const drop5 = (candles[t].close / candles[t - dropWin].close - 1) * 100;

  const isDropping = drop5 < dropMax;
  // concRequirePositive=false（預設）：集中度只要比 concRiseBack 日前高即算「在爬」，即使仍為負（少賣＝回升中）。
  const isConcRising = (!concRequirePositive || conc5 > 0) && conc5 > conc5prev && conc5 <= concCap && volRatio < volRatioMax;
  const isInstBuying = instSum > 0 && instConsecDays >= instConsecMin;

  return {
    date: candles[t].date,
    price: candles[t].close,
    drop5: +drop5.toFixed(2),
    conc5: +conc5.toFixed(2),
    conc5prev: +conc5prev.toFixed(2),
    volRatio: +volRatio.toFixed(2),
    instSumK: Math.round(instSum),
    instConsecDays,
    isDropping,
    isConcRising,
    isInstBuying,
    isHit: isDropping && isConcRising && isInstBuying,
  };
}

/** 在最新一根同時有主力分點+法人資料的日K上評估 */
export function evaluateLatest(
  candles: Candle[],
  brokerByDate: Map<string, number>,
  instByDate: Map<string, number>,
  params: InstStealParams = DEFAULT_PARAMS,
  conc5ByDate?: Map<string, number | null>,
  strictConc = false,
): InstStealEval | null {
  const need = Math.max(params.concWin + params.concRiseBack, 20, params.dropWin, params.instWin);
  // strict：該日有集中度 = FinMind 有；非 strict：FinMind 有 或 broker 有（會退回 broker）
  const hasConc = (d: string) =>
    strictConc && conc5ByDate ? conc5ByDate.get(d) != null : (conc5ByDate?.get(d) != null) || brokerByDate.has(d);
  for (let t = candles.length - 1; t >= need; t--) {
    if (hasConc(candles[t].date) && instByDate.has(candles[t].date)) {
      return evaluateAt(candles, brokerByDate, instByDate, t, params, conc5ByDate, strictConc);
    }
  }
  return null;
}
