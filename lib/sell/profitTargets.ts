/**
 * 獲利目標 = 壓力位估計（課程 CH9-2 依據獲利目標設定「停利」，2026-07-04）
 *
 * 課程規則：獲利目標用「量價研判壓力位置」預估 —
 *   短線（日線）六種：①長均線壓力 ②前高壓力 ③下降切線壓力 ④向上盤整區壓力
 *                     ⑤大量向下缺口壓力 ⑥大量下跌黑K壓力
 *   長線（週線）：同六種看週線。
 *   操作對應：短線 MA5 操作、中長線 MA20 操作（9-1/9-2）。
 *
 * ⚠️ 純顯示層 — 不進任何選股 gate / 排序；不覆寫使用者手填 target1/target2
 *   （手填欄位為使用者資料、平倉凍結拷貝進 trades.json 的語意不變）。
 *
 * 純函式、無 IO。輸入 raw Candle[] 即可（內部跑 computeIndicators）。
 */
import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { findPivots } from '@/lib/analysis/trendAnalysis';
import { analyzeTrendlines } from '@/lib/analysis/trendlineAnalysis';
import { aggregateCandles } from '@/lib/datasource/aggregateCandles';
import { BLACKK_MIN_BODY_PCT, BLACKK_MIN_VOL_RATIO } from '@/lib/analysis/bookThresholds';

export type ProfitTargetType =
  | 'long-ma'        // ① 長均線壓力（價上方的 MA60/120/240）
  | 'pivot-high'     // ② 前高壓力
  | 'trendline'      // ③ 下降切線壓力
  | 'consol-zone'    // ④ 向上盤整區壓力
  | 'down-gap'       // ⑤ 大量向下缺口壓力
  | 'black-k';       // ⑥ 大量下跌黑K壓力

export const PROFIT_TARGET_LABEL: Record<ProfitTargetType, string> = {
  'long-ma':     '長均線壓力',
  'pivot-high':  '前高壓力',
  'trendline':   '下降切線壓力',
  'consol-zone': '向上盤整區壓力',
  'down-gap':    '大量向下缺口壓力',
  'black-k':     '大量下跌黑K壓力',
};

export interface ProfitTarget {
  type: ProfitTargetType;
  label: string;
  /** 壓力價；null = 該類型目前在價格上方找不到壓力位 */
  price: number | null;
  detail: string;
}

export interface ProfitTargetsResult {
  horizon: 'short' | 'long';
  /** 評估基準（short=日線、long=週線）最後一根的收盤與日期 */
  asOfClose: number;
  asOfDate: string;
  targets: ProfitTarget[];
  /** 六種中最接近的上方壓力價（顯示主角） */
  nearestAbove: number | null;
  nearestType: ProfitTargetType | null;
}

// ⚠️ 自創 padding（課程只給壓力「種類」沒給偵測參數）— 工程化參數，export 給測試
/** 壓力位回看窗（根） */
export const TARGET_LOOKBACK = 120;
/** 盤整箱：最少根數 */
export const CONSOL_BOX_MIN_BARS = 6;
/** 盤整箱：狹幅上限（高低差 / 箱底） */
export const CONSOL_BOX_MAX_RANGE = 0.08;
/** 缺口「大量」門檻 vs avgVol5 */
export const GAP_VOL_RATIO = 1.5;

function last<T>(arr: T[]): T { return arr[arr.length - 1]; }

/** ① 長均線壓力：價上方最近的 MA60/120/240（月線 MA20 由操作線負責，不列目標） */
function longMaTarget(c: CandleWithIndicators): ProfitTarget {
  const cands: Array<{ name: string; v: number }> = [];
  if (c.ma60 != null && c.ma60 > c.close) cands.push({ name: 'MA60', v: c.ma60 });
  if (c.ma120 != null && c.ma120 > c.close) cands.push({ name: 'MA120', v: c.ma120 });
  if (c.ma240 != null && c.ma240 > c.close) cands.push({ name: 'MA240', v: c.ma240 });
  if (cands.length === 0) {
    return { type: 'long-ma', label: PROFIT_TARGET_LABEL['long-ma'], price: null, detail: '價格已在長均線之上（無上方均線壓力）' };
  }
  const nearest = cands.reduce((a, b) => (a.v <= b.v ? a : b));
  return { type: 'long-ma', label: PROFIT_TARGET_LABEL['long-ma'], price: nearest.v, detail: `${nearest.name} ${nearest.v.toFixed(2)} 在價格上方` };
}

/** ② 前高壓力：findPivots 最近的上方 pivot high */
function pivotHighTarget(candles: CandleWithIndicators[], idx: number): ProfitTarget {
  const close = candles[idx].close;
  const pivots = findPivots(candles, idx, 10);
  const above = pivots.filter(p => p.type === 'high' && p.price > close);
  if (above.length === 0) {
    return { type: 'pivot-high', label: PROFIT_TARGET_LABEL['pivot-high'], price: null, detail: '創新高中（上方無前高壓力）' };
  }
  const nearest = above.reduce((a, b) => (a.price <= b.price ? a : b));
  return {
    type: 'pivot-high', label: PROFIT_TARGET_LABEL['pivot-high'], price: nearest.price,
    detail: `前波高 ${nearest.price.toFixed(2)}（${candles[nearest.index]?.date ?? ''}）`,
  };
}

/** ③ 下降切線壓力：analyzeTrendlines.descendingResistance */
function trendlineTarget(candles: CandleWithIndicators[], idx: number): ProfitTarget {
  const close = candles[idx].close;
  const r = analyzeTrendlines(candles, idx);
  if (r.descendingResistance != null && r.descendingResistance > close) {
    return {
      type: 'trendline', label: PROFIT_TARGET_LABEL.trendline, price: r.descendingResistance,
      detail: `下降切線今日價位 ${r.descendingResistance.toFixed(2)}`,
    };
  }
  return { type: 'trendline', label: PROFIT_TARGET_LABEL.trendline, price: null, detail: '上方無有效下降切線' };
}

/**
 * ④ 向上盤整區壓力（v1 簡版）：回看窗內「箱底在現價上方」的狹幅盤整箱，
 *    壓力 = 箱底（跌下來後，先前盤整區的下緣變成回升時的第一道壓力）。
 */
function consolZoneTarget(candles: CandleWithIndicators[], idx: number): ProfitTarget {
  const close = candles[idx].close;
  const start = Math.max(0, idx - TARGET_LOOKBACK);
  let best: { bottom: number; top: number; endIdx: number } | null = null;
  for (let end = idx - 1; end >= start + CONSOL_BOX_MIN_BARS; end--) {
    const s = end - CONSOL_BOX_MIN_BARS + 1;
    let hi = -Infinity, lo = Infinity;
    for (let i = s; i <= end; i++) {
      if (candles[i].high > hi) hi = candles[i].high;
      if (candles[i].low < lo) lo = candles[i].low;
    }
    if (lo <= close) continue;              // 箱底要在現價上方才構成壓力
    if ((hi - lo) / lo > CONSOL_BOX_MAX_RANGE) continue; // 要夠狹幅才算盤整箱
    if (best == null || lo < best.bottom) best = { bottom: lo, top: hi, endIdx: end };
    // 已找到最接近現價的箱（由近往遠掃，取箱底最低者即最近壓力）
  }
  if (!best) {
    return { type: 'consol-zone', label: PROFIT_TARGET_LABEL['consol-zone'], price: null, detail: '上方無盤整區' };
  }
  return {
    type: 'consol-zone', label: PROFIT_TARGET_LABEL['consol-zone'], price: best.bottom,
    detail: `上方盤整箱 ${best.bottom.toFixed(2)}~${best.top.toFixed(2)}（箱底為第一道壓力）`,
  };
}

/** ⑤ 大量向下缺口壓力：未回補的向下跳空且缺口區間在現價上方；壓力 = 缺口下緣 */
function downGapTarget(candles: CandleWithIndicators[], idx: number): ProfitTarget {
  const close = candles[idx].close;
  const start = Math.max(1, idx - TARGET_LOOKBACK);
  let bestLowEdge: number | null = null;
  let detail = '';
  for (let i = start; i <= idx; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!(c.high < prev.low)) continue;              // 向下跳空
    const volRatio = c.avgVol5 && c.avgVol5 > 0 ? c.volume / c.avgVol5 : 0;
    if (volRatio < GAP_VOL_RATIO) continue;          // 課程「大量」缺口
    // 回補判定：之後任何一根 high 觸及缺口上緣（prev.low）即視為回補
    let filled = false;
    for (let j = i + 1; j <= idx; j++) {
      if (candles[j].high >= prev.low) { filled = true; break; }
    }
    if (filled) continue;
    const lowEdge = c.high;                           // 缺口下緣 = 跳空日高點
    if (lowEdge <= close) continue;                   // 要在現價上方才是壓力
    if (bestLowEdge == null || lowEdge < bestLowEdge) {
      bestLowEdge = lowEdge;
      detail = `未回補向下缺口 ${lowEdge.toFixed(2)}~${prev.low.toFixed(2)}（${c.date}，量比 ${volRatio.toFixed(1)}x）`;
    }
  }
  if (bestLowEdge == null) {
    return { type: 'down-gap', label: PROFIT_TARGET_LABEL['down-gap'], price: null, detail: '上方無未回補大量缺口' };
  }
  return { type: 'down-gap', label: PROFIT_TARGET_LABEL['down-gap'], price: bestLowEdge, detail };
}

/** ⑥ 大量下跌黑K壓力：大量長黑 K（門檻同 H/L 進場鏡像）高點在現價上方；壓力 = 黑K高點 */
function blackKTarget(candles: CandleWithIndicators[], idx: number): ProfitTarget {
  const close = candles[idx].close;
  const start = Math.max(1, idx - TARGET_LOOKBACK);
  let best: { price: number; date: string } | null = null;
  for (let i = start; i <= idx; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!(c.close < c.open) || c.open <= 0) continue;
    const bodyPct = ((c.open - c.close) / c.open) * 100;
    if (bodyPct < BLACKK_MIN_BODY_PCT) continue;                     // 「長」黑（同 BLACKK 門檻）
    if (prev.volume <= 0 || c.volume / prev.volume < BLACKK_MIN_VOL_RATIO) continue; // 「大量」
    if (c.high <= close) continue;                                    // 高點在現價上方才是壓力
    if (best == null || c.high < best.price) best = { price: c.high, date: String(c.date) };
  }
  if (!best) {
    return { type: 'black-k', label: PROFIT_TARGET_LABEL['black-k'], price: null, detail: '上方無大量下跌黑K壓力' };
  }
  return {
    type: 'black-k', label: PROFIT_TARGET_LABEL['black-k'], price: best.price,
    detail: `大量長黑K（${best.date}）高點 ${best.price.toFixed(2)}`,
  };
}

/**
 * 課程 CH9-2 六種壓力位獲利目標。
 * @param dailyCandles 日線 raw Candle[]（long horizon 內部自行聚合成週線）
 * @param horizon 'short' = 日線六壓力；'long' = 週線六壓力
 * @param index   評估位置（日線 index；缺省 = 最後一根）。long horizon 只支援最後一根。
 */
export function computeProfitTargets(
  dailyCandles: Candle[],
  horizon: 'short' | 'long',
  index?: number,
): ProfitTargetsResult | null {
  if (!dailyCandles || dailyCandles.length < 30) return null;

  let series: CandleWithIndicators[];
  let idx: number;
  if (horizon === 'long') {
    const weekly = aggregateCandles(dailyCandles.slice(0, (index ?? dailyCandles.length - 1) + 1), '1wk');
    if (weekly.length < 15) return null;
    series = computeIndicators(weekly);
    idx = series.length - 1;
  } else {
    series = computeIndicators(dailyCandles);
    idx = index ?? series.length - 1;
  }
  if (idx < 10) return null;
  const c = series[idx];

  const targets: ProfitTarget[] = [
    longMaTarget(c),
    pivotHighTarget(series, idx),
    trendlineTarget(series, idx),
    consolZoneTarget(series, idx),
    downGapTarget(series, idx),
    blackKTarget(series, idx),
  ];

  const withPrice = targets.filter(t => t.price != null) as Array<ProfitTarget & { price: number }>;
  const nearest = withPrice.length > 0 ? withPrice.reduce((a, b) => (a.price <= b.price ? a : b)) : null;

  return {
    horizon,
    asOfClose: c.close,
    asOfDate: String(c.date),
    targets,
    nearestAbove: nearest?.price ?? null,
    nearestType: nearest?.type ?? null,
  };
}
