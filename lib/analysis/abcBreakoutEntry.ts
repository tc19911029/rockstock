/**
 * 策略 G：ABC 突破進場偵測
 *
 * 朱家泓《活用技術分析寶典》Part 11-1 8 種進場位置「位置 6：等 ABC 突破」（p.697）：
 *   多頭上漲一波後，出現 A、B、C 的 3 波修正（形成短期空頭），
 *   反彈大量紅 K 突破下降切線，股價在月線（MA20）上時做多。
 *
 * 同時對應寶典 Part 12-4「18 種空轉多祕笈圖」第 16 圖「突破 ABC 上漲圖」（p.815）。
 *
 * 用戶 Step 2 第 3 條「ABC 突破」直接源頭。
 *
 * 條件：
 *   1. 過去（>=20 根）有過明確的多頭上漲段（最高點顯著高於起點）
 *   2. 隨後 3 波修正（A 跌→B 反彈→C 跌；近期出現「頭頭低、底底低」短空結構）
 *   3. 修正期間兩個高點（A 後反彈頂、B 後反彈頂）連線形成下降切線
 *   4. 今日紅 K 實體 ≥ 2%（寶典 2024）
 *   5. 今日量 ≥ 前日 × 1.3
 *   6. 今日收盤突破下降切線在今日的延伸值
 *   7. 今日收盤站上 MA20
 *
 * 不套戒律（strategyType='kline-pattern'）。
 */

import type { CandleWithIndicators } from '@/types';
import { findPivots, detectTrend } from '@/lib/analysis/trendAnalysis';
import { BOOK_BODY_PCT_MIN, BOOK_VOL_RATIO_MIN } from './bookThresholds';

export interface ABCBreakoutResult {
  isABCBreakout: boolean;
  trendlineValue: number;     // 下降切線在今日的延伸值
  bodyPct: number;
  volumeRatio: number;
  legAHigh: number;           // 多頭波高點（修正起點）
  legALow: number;            // 修正第一段低點
  legBHigh: number;           // 反彈頂點（兩高點連線之一）
  legCLow: number;            // 修正最低點
  // 各腳位的 candle index（走圖可視化 marker 用 idx→date 定位）
  legAHighIdx: number;
  legALowIdx: number;
  legBHighIdx: number;
  legCLowIdx: number;
  preEntryDays: number;       // 修正持續天數
  // ── 旗形（齊形）目標價 D — 課程 6-5 第 3/7 點，純顯示不進 gate（2026-07-05 回測-14）──
  /** 旗桿起點（ABC 修正前那波多頭的起漲低點） */
  poleLow?: number;
  poleLowIdx?: number;
  /** 修正 ≤20 天完成＝課程「飆旗」型態，可算目標價 D */
  isFlagPattern?: boolean;
  /** 目標價 D＝突破日收盤＋旗桿高度（左右兩段等長 D；投射錨點=突破點 ⚠️ 課程只給圖示，錨點屬近似） */
  flagTargetD?: number;
  detail: string;
}

/**
 * 走圖可視化用結構：偵測器「實際選用」的 ABC 四腳（含 index）+ 切線值。
 * 純讀、不影響任何選股邏輯。見 getABCDisplayStructure。
 */
export interface ABCDisplayStructure {
  legAHighIdx: number; legAHigh: number;
  legALowIdx: number;  legALow: number;
  legBHighIdx: number; legBHigh: number;
  legCLowIdx: number;  legCLow: number;
  trendlineValue: number;   // 下降切線在 idx 的延伸值
  brokeTrendline: boolean;  // 今日收盤是否突破切線
  isFullBreakout: boolean;  // detectABCBreakout 是否完全命中（5/5）
}

const MIN_LOOKBACK = 30;
const MAX_LOOKBACK = 80;
const MIN_PRIOR_RUN_PCT = 8;       // 多頭波至少漲 8% 才認可為「上漲一波」
const MAX_PIVOTS = 8;              // findPivots 取最近 8 個 pivot（足以涵蓋 ABC 結構的 4 個轉折）
const MIN_CORRECTION_DROP_PCT = 3; // ABC 修正最低跌幅 (legAHigh→legCLow)，避免太淺的修正誤判
const MIN_CORRECTION_SPAN_DAYS = 6; // ABC 修正最低天數 (legAHigh→legCLow)，避免太快的修正誤判

interface ABCStructure {
  legAHigh: number;
  legAHighIdx: number;
  legALow: number;
  legALowIdx: number;
  legBHigh: number;
  legBHighIdx: number;
  legCLow: number;
  legCLowIdx: number;
  /** 旗桿起點（legAHigh 之前那波多頭的起漲低點）— 旗形目標價 D 用，顯示層 */
  poleLow: number;
  poleLowIdx: number;
}

/**
 * 在 [idx-MAX_LOOKBACK, idx] 區間內搜尋**所有**結構合格的 ABC 修正結構：
 *   多頭頂（legA high）→ 第一波修正底（legA low）→ 反彈高（legB high）→ 修正最低（legC low）
 *
 * 用 findPivots 找轉折點，要求 legAHigh > legBHigh（**頭頭低**），legALow > legCLow（**底底低**）
 * 即修正期間呈現短期空頭結構（書本 Part 11-1 第 6 條原文「形成空頭」）。
 *
 * 為什麼回傳「所有候選」而非貪婪取最近：最近的下跌段未必是 ABC 的 C 段——
 * 可能只是突破前的小回檔（8147 案例：最近低 04-15 不成 ABC，但更早的 03-31 才是真 C 底）；
 * 反過來 600487 案例最近低 05-28 才是真 C 底。因此列舉每個低點 pivot 當 C 底候選，
 * 由 detectABCBreakout 取第一個「結構合格 + 今日收盤突破其下降切線」者。
 */
function findABCStructures(
  candles: CandleWithIndicators[],
  idx: number,
): ABCStructure[] {
  if (idx < MIN_LOOKBACK) return [];

  // 用 idx（含今日）而非 idx-1：ABC 突破當天的「今日紅 K」正是把 C 段下跌反轉、
  // 收上 MA5 的那根 — 它讓 [legC..今日] 這段下跌段「收尾」，C 底才會被 findPivots
  // 認定為「已確認 pivot」。若只看到 idx-1，C 段仍是進行中段、其低點不會回傳，
  // 會誤把「再前一個低」當 C 底，整串腳位往回退一格 → 頭頭高被打槍。
  // （今日這根突破 K 自己開啟的新段是 open segment，includeOpen=false 不會吐回，
  //   故不會被誤當 pivot high；非反轉日時 findPivots(idx) === findPivots(idx-1)。）
  const pivots = findPivots(candles, idx, MAX_PIVOTS);
  if (pivots.length < 4) return [];

  // pivots 由近至遠（findPivots 慣例：index 由大到小）
  const recent = pivots.filter(p => idx - p.index <= MAX_LOOKBACK);
  if (recent.length < 4) return [];

  const out: ABCStructure[] = [];

  // 列舉每個低點 pivot 當 C 底（由近至遠），各自往前組 B峰 / A底 / A峰
  for (const legC of recent) {
    if (legC.type !== 'low') continue;

    // 從 legC 往前找 high(B) → low(A) → high(A)
    const legB = recent.find(p => p.type === 'high' && p.index < legC.index);
    if (!legB) continue;
    const legA = recent.find(p => p.type === 'low' && p.index < legB.index);
    if (!legA) continue;
    const legAHigh = recent.find(p => p.type === 'high' && p.index < legA.index);
    if (!legAHigh) continue;

    // 結構檢查：頭頭低（legAHigh > legBHigh）+ 底底低（legALow > legCLow）
    if (legAHigh.price <= legB.price) continue;
    if (legA.price <= legC.price) continue;

    // 修正深度檢查：legAHigh → legCLow 跌幅 ≥ MIN_CORRECTION_DROP_PCT
    const correctionDropPct = ((legAHigh.price - legC.price) / legAHigh.price) * 100;
    if (correctionDropPct < MIN_CORRECTION_DROP_PCT) continue;

    // 修正天數檢查：legAHigh → legCLow 至少跨 MIN_CORRECTION_SPAN_DAYS 天
    const correctionSpanDays = legC.index - legAHigh.index;
    if (correctionSpanDays < MIN_CORRECTION_SPAN_DAYS) continue;

    // 多頭波幅檢查：legAHigh 相對更早的低點 ≥ MIN_PRIOR_RUN_PCT
    // （該低點同時就是旗形「旗桿」起點，留給目標價 D 顯示用）
    let poleLow: number;
    let poleLowIdx: number;
    const earlierLow = recent.find(p => p.type === 'low' && p.index < legAHigh.index);
    if (earlierLow) {
      const runPct = ((legAHigh.price - earlierLow.price) / earlierLow.price) * 100;
      if (runPct < MIN_PRIOR_RUN_PCT) continue;
      poleLow = earlierLow.price;
      poleLowIdx = earlierLow.index;
    } else {
      // 沒有更早的低點 → 用區間最低近似
      const startIdx = Math.max(0, idx - MAX_LOOKBACK);
      let minLow = candles[startIdx].low;
      let minLowIdx = startIdx;
      for (let i = startIdx; i < legAHigh.index; i++) {
        if (candles[i].low < minLow) { minLow = candles[i].low; minLowIdx = i; }
      }
      const runPct = ((legAHigh.price - minLow) / minLow) * 100;
      if (runPct < MIN_PRIOR_RUN_PCT) continue;
      poleLow = minLow;
      poleLowIdx = minLowIdx;
    }

    out.push({
      legAHigh: legAHigh.price,
      legAHighIdx: legAHigh.index,
      legALow: legA.price,
      legALowIdx: legA.index,
      legBHigh: legB.price,
      legBHighIdx: legB.index,
      legCLow: legC.price,
      legCLowIdx: legC.index,
      poleLow,
      poleLowIdx,
    });
  }

  return out;
}

/**
 * 計算下降切線（連 legAHigh 與 legBHigh 兩個高點）在今日 idx 的延伸值。
 */
function trendlineAtIndex(s: ABCStructure, idx: number): number {
  // 線性外推：y = y1 + (x - x1) × slope
  const slope = (s.legBHigh - s.legAHigh) / (s.legBHighIdx - s.legAHighIdx);
  return s.legBHigh + slope * (idx - s.legBHighIdx);
}

/**
 * 偵測位置 6 ABC 突破。
 *
 * @returns ABCBreakoutResult（命中時）或 null
 */
export function detectABCBreakout(
  candles: CandleWithIndicators[],
  idx: number,
): ABCBreakoutResult | null {
  if (idx < MIN_LOOKBACK) return null;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.volume <= 0 || c.open <= 0) return null;

  // 與結構無關的今日 K 線條件，先擋（便宜的拒絕）：
  // 2. 紅 K
  if (c.close <= c.open) return null;
  // 3. 紅 K 實體 ≥ 2%
  const bodyPct = ((c.close - c.open) / c.open) * 100;
  if (bodyPct < BOOK_BODY_PCT_MIN) return null;
  // 4. 量比 ≥ 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < BOOK_VOL_RATIO_MIN) return null;
  // 6. 收盤站上 MA20 且月線向上（課程 6-5「月線之上**而且月線向上**，鐵則不能改變」）
  // 2026-07-05 回測-15 按課程：補月線向上（detector 單獨用時之前缺這條）
  if (c.ma20 == null || c.close <= c.ma20) return null;
  const prevMa20ForJ = candles[idx - 1]?.ma20;
  if (prevMa20ForJ != null && c.ma20 < prevMa20ForJ) return null;

  // 1. 列舉所有結構合格的 ABC，取第一個（由近至遠）同時滿足：
  //    0'. ABC 修正之前（legAHigh 處）為多頭（書本 Part 11-1 p.697「多頭一波後 ABC 修正再攻」）
  //        — 2026-05-10 修：不檢查「今日仍多頭」（突破當日通常是短空/盤整），只看修正之前。
  //    5. 今日收盤突破該結構的下降切線（legAHigh→legBHigh 連線）在今日的延伸值
  const structures = findABCStructures(candles, idx);
  for (const abc of structures) {
    if (detectTrend(candles, abc.legAHighIdx) !== '多頭') continue;

    const trendlineValue = trendlineAtIndex(abc, idx);
    if (c.close <= trendlineValue) continue;

    const preEntryDays = idx - abc.legAHighIdx;

    // ── 旗形（齊形）目標價 D — 課程 6-5 純顯示（2026-07-05 回測-14）──────────
    // 投影片第 3 點：「多頭的 ABC 一般在 20 天之內完成；若突破點落在 20 天之內，
    // 就視為飆旗（旗形）型態，可以計算目標價 D」。
    // 第 7 點：旗桿＝前一波低到高的距離，兩段等長的 D（左邊旗桿、右邊投射）。
    // 課程也強調「看不懂齊形沒關係、以趨勢操作為主，還可能超標」→ 純追蹤參考。
    // 逐字-27（2026-07-07 render PDF 更正）：課程 6-5 p1 圖示 D 箭頭底端落在「C 波轉折低」虛線、頂端=目標價，
    // 投射錨＝legCLow 非突破日收盤（c.close > legCLow 會系統性高估目標價）。改用 legCLow + 旗桿高度。
    const FLAG_MAX_CORRECTION_DAYS = 20;
    const isFlagPattern = preEntryDays <= FLAG_MAX_CORRECTION_DAYS;
    const poleHeight = abc.legAHigh - abc.poleLow;
    const flagTargetD = isFlagPattern && poleHeight > 0 ? abc.legCLow + poleHeight : undefined;

    return {
      isABCBreakout: true,
      trendlineValue,
      bodyPct,
      volumeRatio,
      legAHigh: abc.legAHigh,
      legALow: abc.legALow,
      legBHigh: abc.legBHigh,
      legCLow: abc.legCLow,
      legAHighIdx: abc.legAHighIdx,
      legALowIdx: abc.legALowIdx,
      legBHighIdx: abc.legBHighIdx,
      legCLowIdx: abc.legCLowIdx,
      preEntryDays,
      poleLow: abc.poleLow,
      poleLowIdx: abc.poleLowIdx,
      isFlagPattern,
      flagTargetD,
      detail:
        `ABC 突破（A峰 ${abc.legAHigh.toFixed(1)}→A底 ${abc.legALow.toFixed(1)}→` +
        `B峰 ${abc.legBHigh.toFixed(1)}→C底 ${abc.legCLow.toFixed(1)}，` +
        `修正 ${preEntryDays} 天，今日突破下降切線 ${trendlineValue.toFixed(1)}＋實體 ${bodyPct.toFixed(2)}%＋量×${volumeRatio.toFixed(2)}＋站上 MA20）` +
        (flagTargetD != null
          ? `｜修正 ≤20 天＝飆旗型態，目標價 D≈${flagTargetD.toFixed(1)}（旗桿 ${abc.poleLow.toFixed(1)}→${abc.legAHigh.toFixed(1)} 投射，課程 6-5：追蹤參考、可能超標）`
          : ''),
    };
  }

  return null;
}

/**
 * 走圖可視化用：回傳偵測器「實際會用」的 ABC 四腳（含 index），給走圖畫 A/B/C marker + 切線。
 *
 * 動機（2026-05-30）：走圖上那條綠色「下降切線」是通用線（連最近兩波峰），與 ABC 偵測器無關；
 *   兩者口徑曾不一致而沒人發現（600487 案例）。此函式讓走圖能畫出「偵測器自己選的腳位與切線」，
 *   偵測器若再抓錯腳位，marker 會明顯畫錯位置 → 肉眼即可驗證，不再靠運氣。
 *
 * - 命中（5/5）→ 回傳 detectABCBreakout 實際選的那組，與判斷完全一致（isFullBreakout=true）
 * - 未命中但有結構合格候選 → 回傳第一個（最近）候選，方便看「為什麼沒中」
 *   （例：腳位畫對了但今日收盤沒突破切線 → brokeTrendline=false）
 *
 * 純讀、不影響任何選股邏輯。
 */
export function getABCDisplayStructure(
  candles: CandleWithIndicators[],
  idx: number,
): ABCDisplayStructure | null {
  if (idx < MIN_LOOKBACK) return null;
  const c = candles[idx];
  if (!c) return null;

  const full = detectABCBreakout(candles, idx);
  if (full) {
    return {
      legAHighIdx: full.legAHighIdx, legAHigh: full.legAHigh,
      legALowIdx: full.legALowIdx, legALow: full.legALow,
      legBHighIdx: full.legBHighIdx, legBHigh: full.legBHigh,
      legCLowIdx: full.legCLowIdx, legCLow: full.legCLow,
      trendlineValue: full.trendlineValue,
      brokeTrendline: true,
      isFullBreakout: true,
    };
  }

  const candidates = findABCStructures(candles, idx);
  if (candidates.length === 0) return null;
  const abc = candidates[0];
  const trendlineValue = trendlineAtIndex(abc, idx);
  return {
    legAHighIdx: abc.legAHighIdx, legAHigh: abc.legAHigh,
    legALowIdx: abc.legALowIdx, legALow: abc.legALow,
    legBHighIdx: abc.legBHighIdx, legBHigh: abc.legBHigh,
    legCLowIdx: abc.legCLowIdx, legCLow: abc.legCLow,
    trendlineValue,
    brokeTrendline: c.close > trendlineValue,
    isFullBreakout: false,
  };
}
