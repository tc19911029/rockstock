import { CandleWithIndicators } from '@/types';
import type { StrategyThresholds } from '@/lib/strategy/StrategyConfig';
import { findSwingHigh, findSwingLow } from '@/lib/rules/ruleUtils';
import { BOOK_VOL_RATIO_MIN, MA20_WARN_DEVIATION_PCT } from './bookThresholds';
import { detectExtraHighWinPositions, detectPullbackBuy, detectRangeBreakout } from './highWinPositions';
import { detectVolumePriceDivergence, detectHighPeakVolume, detectChokingVolume } from './volumePatterns';
import { detectMacdOsc7, isKdHighSaturated, detectKdPeakDivergence } from './indicatorPatterns';
import { detectBollingerSignals } from './bollingerPatterns';
import { detectOneDayReversal, detectTopFormation } from './reversalStructure';
import { detectIslandReversal, detectTwoGapsInThreeDays, classifyGapUp } from './gapPatterns';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TrendState = '多頭' | '空頭' | '盤整';

export type TrendPosition =
  | '多頭上升段'
  | '接近壓力區'          // 多頭中，收盤 ≤ 3% 於近期 swing high（2026-05-21 林穎 CH2 + 朱老師 CH3）
  | '末升段(高檔)'
  | '空頭下跌段'
  | '接近支撐區'          // 空頭中，收盤 ≤ 3% 於近期 swing low
  | '末跌段(低檔)'
  | '盤整觀望'
  // ── 相容舊欄位（歷史 L4 掃描檔會出現）──
  | '起漲段' | '主升段' | '起跌段' | '主跌段';

export interface ConditionResult {
  pass: boolean;
  detail: string;
}

export interface SixConditionsResult {
  trend:     ConditionResult & { state: TrendState };
  ma:        ConditionResult & { alignment: string };
  position:  ConditionResult & { stage: TrendPosition; deviation: number | null };
  volume:    ConditionResult & { ratio: number | null; threshold: number };
  kbar:      ConditionResult & { type: string; bodyPct: number; closePos: number };
  indicator: ConditionResult & { macd: boolean; kd: boolean; kdK: number | null; macdOSC: number | null };
  totalScore: number; // 0–6
  coreScore:  number; // 0–5（前5個必要條件）
  isCoreReady: boolean; // 前5個全過 = true
  /** 書本高勝率 6 位置加分 tag（p.749-754 + 圖表 12-1-7）— 不是 gate，僅資訊顯示 */
  highWinTags: string[];
}

// ── Pivot detection ───────────────────────────────────────────────────────────

export interface Pivot {
  index: number;
  price: number;
  type: 'high' | 'low';
}

/**
 * 朱家泓《活用技術分析寶典》p.21-22 短線轉折波畫法（收盤 vs MA5）：
 *   - close > MA5 = 正價區；close < MA5 = 負價區
 *   - 正→負（跌破 MA5）：取正價區 + 跌破當天，max(high) = 頭
 *   - 負→正（突破 MA5）：取負價區 + 突破當天，min(low) = 底
 *
 * 交界日雙重計算：既是舊段的結束候選（「連同跌破當天」），
 * 也是新段的第一根 bar（因為它的 close 已在新段那一側）。
 * 下一次交界時的 pivot window = [上一交界日..本次交界日]。
 *
 * @param includeOpen true 時把「進行中段」的 running max/min 當成 provisional pivot 加在最後
 *                    （用於即時趨勢判定；書本嚴格確認要等 MA5 反向穿越）
 * @param minSwingRatio 最小擺幅比例（預設 0 = 不過濾）。> 0 時，過濾掉相鄰反向 pivot
 *                      價差 < `minSwingRatio × close` 或 `0.5 × ATR(14)` 取大者的小擺動。
 *                      用於型態偵測（避免震盪雜訊產生的假頭底擾亂三重底/頭肩底辨識）。
 *                      不影響原有呼叫點（detectTrend / 走圖 marker 走預設 0）。
 */
export function findPivots(
  candles: CandleWithIndicators[],
  endIndex: number,
  maxPivots = 10,
  includeOpen = false,
  minSwingRatio = 0,
): Pivot[] {
  const lookback = Math.min(endIndex, 120);
  const start = Math.max(0, endIndex - lookback);

  const pivots: Pivot[] = [];
  let segStart = -1;
  let segType: 'positive' | 'negative' | null = null;

  for (let i = start; i <= endIndex; i++) {
    const c = candles[i];
    if (!c || c.ma5 == null) continue;
    // 2026-07-05 課程對齊（CH1-1「跟均線平的表示還沒跌破，要等明天確認」）：
    // 收盤 == MA5（平盤）沿用前一段狀態，不當跌破/站上（舊版歸 negative 會提前一天確認轉折）
    if (c.close === c.ma5 && segType !== null) continue;
    const curr: 'positive' | 'negative' = c.close > c.ma5 ? 'positive' : 'negative';

    if (segType === null) {
      segType = curr;
      segStart = i;
      continue;
    }

    if (curr === segType) continue;

    // 狀態切換：pivot window = [segStart..i]，交界日 i 同時屬舊段尾+新段首
    if (segType === 'positive') {
      let bestPrice = -Infinity, bestIdx = segStart;
      for (let j = segStart; j <= i; j++) {
        if (candles[j].high > bestPrice) { bestPrice = candles[j].high; bestIdx = j; }
      }
      pivots.push({ index: bestIdx, price: bestPrice, type: 'high' });
    } else {
      let bestPrice = Infinity, bestIdx = segStart;
      for (let j = segStart; j <= i; j++) {
        if (candles[j].low < bestPrice) { bestPrice = candles[j].low; bestIdx = j; }
      }
      pivots.push({ index: bestIdx, price: bestPrice, type: 'low' });
    }

    // 新段從交界日本身開始（雙重計算）
    segType = curr;
    segStart = i;
  }

  // 可選：把「進行中段」的 running max/min 當成 provisional pivot
  // 用於即時趨勢判定——雖然 MA5 還沒反向穿越確認，但該段目前最高/最低已足夠作為趨勢比較依據
  if (includeOpen && segType !== null && segStart >= 0 && segStart <= endIndex) {
    if (segType === 'positive') {
      let bestPrice = -Infinity, bestIdx = segStart;
      for (let j = segStart; j <= endIndex; j++) {
        if (candles[j].high > bestPrice) { bestPrice = candles[j].high; bestIdx = j; }
      }
      pivots.push({ index: bestIdx, price: bestPrice, type: 'high' });
    } else {
      let bestPrice = Infinity, bestIdx = segStart;
      for (let j = segStart; j <= endIndex; j++) {
        if (candles[j].low < bestPrice) { bestPrice = candles[j].low; bestIdx = j; }
      }
      pivots.push({ index: bestIdx, price: bestPrice, type: 'low' });
    }
  }

  // 可選：ATR / 比例過濾（minSwingRatio > 0）— 移除震盪雜訊產生的小擺幅 pivot
  // 演算法：oldest→newest 走，若新 pivot 與前一個保留 pivot 的價差小於 threshold，
  //   則：若同向（不會發生於原始 MA5 分段法，但合併後可能）則保留更極端者；
  //        若反向但擺幅太小，丟棄當前 pivot（讓真正的轉折繼續）
  // 注意：findPivots 原本以 MA5 正負區交替產出 high-low-high-low，過濾後仍維持交替。
  let filtered = pivots;
  if (minSwingRatio > 0 && pivots.length >= 2) {
    const last = candles[endIndex];
    const closeRef = last?.close ?? 0;
    const atrRef = last?.atr14 ?? 0;
    const threshold = Math.max(minSwingRatio * closeRef, 0.5 * atrRef);
    if (threshold > 0) {
      const out: Pivot[] = [];
      for (const p of pivots) {
        const prev = out[out.length - 1];
        if (!prev) {
          out.push(p);
          continue;
        }
        if (prev.type === p.type) {
          // 同向（過濾後可能出現）：保留更極端者
          const isHigh = p.type === 'high';
          if ((isHigh && p.price > prev.price) || (!isHigh && p.price < prev.price)) {
            out[out.length - 1] = p;
          }
          continue;
        }
        // 反向：擺幅太小則丟棄當前 pivot
        const swing = Math.abs(p.price - prev.price);
        if (swing < threshold) continue;
        out.push(p);
      }
      filtered = out;
    }
  }

  return filtered.slice(-maxPivots).reverse();
}

// ── Structural-break pivot resolution（趨勢結構即時判定用）─────────────────────

/**
 * 把「已確認 pivot」+「開放段已破前 pivot 的延伸」合併成趨勢判定用的 pivot 列表。
 *
 * 為什麼需要這個 helper（用戶 2026-05-21 6770 力積電案例）：
 *   原 findPivots(includeOpen=false) 嚴格只回 MA5 反向穿越確認的 pivot。問題是
 *   open segment 內如果運行 low/high 已穿越前一同型 pivot，**該段最終 pivot 必定**
 *   ≥/≤ 此極值，結構破壞已成事實（未來只會更極端、不可能變沒破）—— 此時不該等
 *   MA5 反向穿越才承認。例：6770 5/13 確認低 59 → 5/20 open seg 內 low 56.6 已破，
 *   5/21 close 59.1 雖在 59 之上但結構已破，不該再判多頭。
 *
 * 為什麼不直接改 findPivots：其他 40+ 消費者（C 買法盤整突破、N/M/P 各 detector 等）
 *   依賴 findPivots 回「嚴格已確認」pivot 做型態結構驗證，混入 provisional 會破壞它們
 *   （例：C 買法把今日突破點誤當新 pivot high，盤整判定崩潰）。
 *
 * 為什麼不直接用 includeOpen=true：那會把所有開放段運行極值都加入（連未破前 pivot 的
 *   亦加），會造成 603626 假象（運行低 23.23 > 確認低 22.9 卻被插入，把真實底底低
 *   蓋成底底高）。
 *
 * 正解：只在「open seg running 極值已超越前一同型確認 pivot」時，把該極值當成 pivot
 *   延伸加入。同時避免 603626 假象 + 抓到 6770 結構性破壞。
 */
function resolveStructuralPivots(
  candles: CandleWithIndicators[],
  index: number,
): Pivot[] {
  const confirmed = findPivots(candles, index, 8, false);
  if (confirmed.length === 0) return confirmed;

  // 找最近確認 pivot（不分型別）的 index 後一根開始，掃 open seg running min/max
  const latestPivotIdx = Math.max(...confirmed.map(p => p.index));
  if (latestPivotIdx >= index) return confirmed;

  let openLow = Infinity, openLowIdx = -1;
  let openHigh = -Infinity, openHighIdx = -1;
  let openCloseMin = Infinity, openCloseMax = -Infinity;
  for (let i = latestPivotIdx + 1; i <= index; i++) {
    const k = candles[i];
    if (!k) continue;
    if (k.low  < openLow)  { openLow  = k.low;  openLowIdx  = i; }
    if (k.high > openHigh) { openHigh = k.high; openHighIdx = i; }
    if (k.close < openCloseMin) openCloseMin = k.close;
    if (k.close > openCloseMax) openCloseMax = k.close;
  }

  const extended: Pivot[] = [];
  // 2026-07-05 裁決-1（使用者拍板回歸課程）：「破前低/過前頭」的判定用**收盤**
  //（課程 CH1 鐵律「收盤判定，不看盤中」「收盤跌破前低才變」）。
  // 舊版用盤中極值（2026-05-21 6770 決議）— 下影線刺破前低、收盤收回，當天就翻結構 → 誤判。
  // 收盤確認破壞後，延伸 pivot 的「價位」仍用該段真實極值（轉折點本來就是 high/low）。
  const latestLow  = confirmed.find(p => p.type === 'low');
  if (latestLow && openLowIdx >= 0 && openCloseMin < latestLow.price) {
    extended.push({ index: openLowIdx, price: openLow, type: 'low' });
  }
  const latestHigh = confirmed.find(p => p.type === 'high');
  if (latestHigh && openHighIdx >= 0 && openCloseMax > latestHigh.price) {
    extended.push({ index: openHighIdx, price: openHigh, type: 'high' });
  }

  if (extended.length === 0) return confirmed;
  // confirmed 是 newest-first；延伸 pivot 比所有 confirmed 還新 → 放最前面
  return [...extended.sort((a, b) => b.index - a.index), ...confirmed];
}

// ── Trend detection ───────────────────────────────────────────────────────────

/**
 * 朱老師趨勢判斷（對齊寶典 p.35）：
 *   「由最後一天收盤 K 線往左和最近的「頭」及最近的「底」比較，判定是否符合多頭架構」
 *
 *   多頭 = 頭頭高 + 不破前底（含底底相等）
 *   空頭 = 底底低 + 不過前頭（含頭頭相等）
 *   盤整 = 波浪不完整 / 矛盾（頭高底低、頭低底高）/ 兩邊都未突破
 *
 * 2026-05-10 放寬：底底「相等」也算「不破底」（書本「底底高」精神是「不破前底」）。
 *   例：6770 力積電兩底都 51.6 + 新頭突破前頭 → 應為多頭，原嚴格 > 誤判為盤整。
 *   對稱：頭頭「相等」也算「不過頭」。
 *   不是 ε 容差（exact equality only），符合「不加數值容差」原則。
 *
 * 波浪由 findPivots (p.22 MA5 分段法) 產出。
 */
export function detectTrend(
  candles: CandleWithIndicators[],
  index: number,
): TrendState {
  if (index < 20) return '盤整';

  // 用 resolveStructuralPivots：已確認 pivot + open seg 已破前 pivot 的延伸。
  //   - 避免 603626 假象（open seg 未破前 pivot 不會誤插）
  //   - 抓到 6770 結構性破壞（open seg 已破前 pivot 視為 pivot 已成立）
  //   詳見 resolveStructuralPivots 註解。
  const structuralPivots = resolveStructuralPivots(candles, index);
  const highs = structuralPivots.filter(p => p.type === 'high').slice(0, 2);
  const lows  = structuralPivots.filter(p => p.type === 'low').slice(0, 2);

  // 書本要求同時看到最近兩個頭 + 最近兩個底才能判斷
  if (highs.length < 2 || lows.length < 2) return '盤整';

  const c = candles[index];
  // 即時覆蓋：今日 close 已突破/跌破最近 pivot 時，立即更新結構判定
  //   immediateNewHigh：空頭/盤整轉多頭的即時確認
  //   immediateNewLow ：多頭/盤整轉空頭的即時確認
  const immediateNewHigh = c.close > highs[0].price;
  const immediateNewLow  = c.close < lows[0].price;

  // 多頭側：頭頭高（嚴格）+ 不破前底（含相等）
  const higherHighs = highs[0].price > highs[1].price || immediateNewHigh;
  const noLowerLow  = !immediateNewLow && lows[0].price >= lows[1].price;
  // 空頭側：底底低（嚴格）+ 不過前頭（含相等）— 鏡像對稱
  const lowerLows   = lows[0].price < lows[1].price || immediateNewLow;
  const noHigherHigh = !immediateNewHigh && highs[0].price <= highs[1].price;

  // 多頭 / 空頭 條件互斥；同時成立（極罕見極端 case）→ 留給盤整
  if (higherHighs && noLowerLow && !lowerLows) return '多頭';
  if (lowerLows  && noHigherHigh && !higherHighs) return '空頭';
  return '盤整';
}

// ── 盤整四型態分類（課程 CH1-4，純顯示不進 gate）────────────────────────────

export type ConsolidationShape = '三角收斂' | '矩形盤整' | '上升三角' | '下降三角';

/** 頭/底「差不多平」容差（課程投影片只畫圖沒給數字 ⚠️ 自創 padding 1.5%） */
const CONSOL_FLAT_TOL = 0.015;

/**
 * 盤整四種常見型態（課程 CH1-4 投影片，左上→右下）：
 *   三角收斂＝頭頭低＋底底高；矩形＝上頭平＋下底平；
 *   上升三角＝上平＋底底高；下降三角＝頭頭低＋下平。
 *
 * 課程明講：四種只是盤整的**外觀分類**，操作一律「畫上下頸線、等突破/跌破表態」，
 * 不必為每種各記一套做法 → 本函式**純顯示標籤**，不做任何選股/排序輸入。
 *
 * 只在 detectTrend === '盤整' 時有意義；用與 detectTrend 相同的 structural pivots
 * （最近兩頭兩底）判定，對不上四型任何一型（如頭高底低發散）回 null。
 */
export function classifyConsolidationShape(
  candles: CandleWithIndicators[],
  index: number,
): { shape: ConsolidationShape; detail: string } | null {
  if (index < 20) return null;
  const pivots = resolveStructuralPivots(candles, index);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (highs.length < 2 || lows.length < 2) return null;

  const flat = (a: number, b: number) => b > 0 && Math.abs(a - b) / b <= CONSOL_FLAT_TOL;
  const highFlat  = flat(highs[0].price, highs[1].price);
  const lowFlat   = flat(lows[0].price, lows[1].price);
  const lowerHigh = !highFlat && highs[0].price < highs[1].price;  // 頭頭低
  const higherLow = !lowFlat && lows[0].price > lows[1].price;     // 底底高

  const shape: ConsolidationShape | null =
    lowerHigh && higherLow ? '三角收斂' :
    highFlat  && lowFlat   ? '矩形盤整' :
    highFlat  && higherLow ? '上升三角' :
    lowerHigh && lowFlat   ? '下降三角' :
    null;
  if (!shape) return null;

  const upper = Math.max(highs[0].price, highs[1].price);
  const lower = Math.min(lows[0].price, lows[1].price);
  return {
    shape,
    detail: `${shape}（上頸線≈${upper.toFixed(2)}／下頸線≈${lower.toFixed(2)}，課程 CH1-4：畫上下頸線等市場表態，突破做多、跌破做空）`,
  };
}

// ── Trendline (切線) detection — 書本 p.37/p.38 警示用，不做進出場判斷 ───────────

export interface TrendlineInfo {
  /** 線上兩個 pivot 的 index（由舊到新） */
  fromIndex: number;
  toIndex: number;
  fromPrice: number;
  toPrice: number;
  /** 以當前 index 延伸出的線值（今天這條線的價格） */
  todayValue: number;
}

export interface TrendlineWarning {
  /** 下降切線（連兩個頭頭低的頭），無則 null */
  descending: TrendlineInfo | null;
  /** 上升切線（連兩個底底高的底），無則 null */
  ascending: TrendlineInfo | null;
  /** 收盤突破下降切線 → 空頭反彈轉強（p.37 ❶：非做多位置） */
  breakoutBullish: boolean;
  /** 收盤跌破上升切線 → 多頭回檔轉弱（p.38 ❼：非放空位置） */
  breakoutBearish: boolean;
  /** UI 顯示用文字（無警示回空字串） */
  warningText: string;
}

/**
 * 偵測切線突破/跌破（書本 p.37/p.38）。
 *
 * 切線畫法：
 *   - 下降切線 = 最近兩個頭，後頭低於前頭（頭頭低）→ 兩點連直線延伸
 *   - 上升切線 = 最近兩個底，後底高於前底（底底高）→ 兩點連直線延伸
 *
 * 警示訊號：
 *   - 收盤 > 下降切線當日值 → breakoutBullish（空頭轉強警示，非做多位置）
 *   - 收盤 < 上升切線當日值 → breakoutBearish（多頭轉弱警示，非放空位置）
 *
 * 此函式不改變任何進出場決策，只產警示。
 */
export function detectTrendlineBreakout(
  candles: CandleWithIndicators[],
  index: number,
): TrendlineWarning {
  const empty: TrendlineWarning = {
    descending: null, ascending: null,
    breakoutBullish: false, breakoutBearish: false, warningText: '',
  };
  if (index < 2) return empty;

  const pivots = findPivots(candles, index, 8);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 2);

  const close = candles[index].close;

  // 下降切線：highs[1] 較早、highs[0] 較新；若 highs[0] < highs[1] 為頭頭低
  let descending: TrendlineInfo | null = null;
  let breakoutBullish = false;
  if (highs.length === 2 && highs[0].price < highs[1].price) {
    const older = highs[1];  // 較早
    const newer = highs[0];  // 較新
    const slope = (newer.price - older.price) / (newer.index - older.index);
    const todayValue = older.price + slope * (index - older.index);
    descending = {
      fromIndex: older.index, toIndex: newer.index,
      fromPrice: older.price, toPrice: newer.price,
      todayValue,
    };
    breakoutBullish = close > todayValue;
  }

  // 上升切線：lows[1] 較早、lows[0] 較新；若 lows[0] > lows[1] 為底底高
  let ascending: TrendlineInfo | null = null;
  let breakoutBearish = false;
  if (lows.length === 2 && lows[0].price > lows[1].price) {
    const older = lows[1];
    const newer = lows[0];
    const slope = (newer.price - older.price) / (newer.index - older.index);
    const todayValue = older.price + slope * (index - older.index);
    ascending = {
      fromIndex: older.index, toIndex: newer.index,
      fromPrice: older.price, toPrice: newer.price,
      todayValue,
    };
    breakoutBearish = close < todayValue;
  }

  const parts: string[] = [];
  if (breakoutBullish)  parts.push('⚠️ 突破下降切線：空頭反彈轉強訊號（非做多位置）');
  if (breakoutBearish)  parts.push('⚠️ 跌破上升切線：多頭回檔轉弱訊號（非放空位置）');

  return {
    descending, ascending,
    breakoutBullish, breakoutBearish,
    warningText: parts.join('\n'),
  };
}

// ── Position / stage detection ────────────────────────────────────────────────

/**
 * 以「股價距 MA20 的乖離率」判斷目前在哪個位置。
 * 書中核心：「末升段（高檔）乖離過大，不宜追高。」
 *
 * 判斷方式對齊書本 p.45-52 + 朱老師波浪理論實戰觀點：
 *
 *   末升段訊號（任兩項成立 = 末升段，全部書本原文）：
 *     1. 連續 3 根大量長紅 K（p.46 特性 5）
 *     2. 高檔異常爆天量 + 長黑 K（p.50 情境①）
 *     3. 連續 2~3 日爆量後不漲（p.52 情境②）
 *     4. 量價背離（今日創新高但量縮 vs 前波頭）
 *     5. 遛狗理論：MA5 乖離 >15% OR MA20 乖離 >15%（股價遛太遠；2026-04-22 起兩者皆 15%，與 code 一致）
 *
 *   主升段：波數 ≥ 2 但不到末升段（行情已站穩，仍可抱單）
 *   起漲段：波數 < 2（剛突破，風險最小）
 *
 * 空頭方向對稱（用底底低次數判斷）。
 */

/** 連續 n 根長黑 K（末跌段合議用，2026-07-05 批次B）
 *  空頭對量要求寬鬆（CH5-1 投影片「沒人買股價就跌」）→ 不設量門檻，只看連續長黑實體 */
function hasConsecLongBlack(candles: CandleWithIndicators[], index: number, n = 3): boolean {
  if (index < n) return false;
  for (let i = 0; i < n; i++) {
    const c = candles[index - i];
    if (!c) return false;
    const body = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
    if (!(c.close < c.open && body >= 0.02)) return false;
  }
  return true;
}

/** 連續 n 根大量長紅 K（p.46 特性 5：連漲 3 天以上容易賣壓）
 *  「大量」對齊書本 p.54 第 4 條：量 ≥ 前日 × 1.3 */
function hasConsecLongRed(candles: CandleWithIndicators[], index: number, n = 3): boolean {
  if (index < n - 1) return false;
  for (let i = 0; i < n; i++) {
    const c = candles[index - i];
    const p = candles[index - i - 1];
    if (!c || !p) return false;
    const body = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
    const isLongRed = c.close > c.open && body >= 0.02;
    if (!isLongRed) return false;
    // 書本 p.54：量 ≥ 前日 × 1.3
    if (p.volume > 0 && c.volume < p.volume * 1.3) return false;
  }
  return true;
}

/** 高檔異常爆天量 + 長黑 K（p.50 情境①）
 *  2026-07-05 忠實度修：課程 CH4-7 原文「量比前一天多 **2 到 5 倍以上**」— 舊版寫死 ×3，
 *  2~3 倍的爆天量黑K（課程已該警覺）全漏。門檻降到 ×2 對齊課程下緣。
 *  （消費端=detectTrendPosition 末升段合議 ≥2 訊號，非單獨 gate。） */
function hasBlowoffBlackReversal(candles: CandleWithIndicators[], index: number): boolean {
  const c = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return false;
  // 今日量 ≥ 前日量 × 2（課程 2~5 倍區間下緣）
  if (prev.volume <= 0) return false;
  if (c.volume < prev.volume * 2) return false;
  // 今日是長黑 K（實體 ≥ 2%）
  const body = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  const isLongBlack = c.close < c.open && body >= 0.02;
  return isLongBlack;
}

/** 連續 2~3 天爆大量（≥ 5 日均量 × 2）後股價不漲或下跌（p.52 情境②） */
function hasConsecBlowoffNoRise(candles: CandleWithIndicators[], index: number): boolean {
  if (index < 3) return false;
  // 過去 2~3 日皆爆大量
  let blowoffCount = 0;
  for (let i = 1; i <= 3; i++) {
    const c = candles[index - i + 1];  // index..index-2
    if (!c || c.avgVol5 == null) continue;
    if (c.volume >= c.avgVol5 * 2) blowoffCount++;
  }
  if (blowoffCount < 2) return false;
  // 最新 1~2 根不漲（今日或昨日收盤 ≤ 兩天前收盤）
  const c = candles[index];
  const y2 = candles[index - 2];
  if (!c || !y2) return false;
  return c.close <= y2.close;
}

/** 量價背離：今日創近期新高，但今日成交量 < 前一個頭當日成交量（書本「量縮」） */
function hasVolumePriceDivergence(
  candles: CandleWithIndicators[],
  index: number,
  pivots: Pivot[],
): boolean {
  const c = candles[index];
  if (!c) return false;
  const lastHigh = pivots.find(p => p.type === 'high');
  if (!lastHigh) return false;
  const prevHighCandle = candles[lastHigh.index];
  if (!prevHighCandle) return false;
  // 書本：今日創新高（close > 前頭） + 量縮（量 < 前頭量，嚴格比較）
  if (c.close <= lastHigh.price) return false;
  return c.volume < prevHighCandle.volume;
}

/** 遛狗理論：MA5 乖離 >15% OR MA20 乖離 >15%（股價遛太遠，隨時拉回；對齊 2026-04-22 用戶設定） */
function isBiasOverExtended(candles: CandleWithIndicators[], index: number): boolean {
  const c = candles[index];
  if (!c) return false;
  if (c.ma5 != null && c.ma5 > 0) {
    const ma5Dev = (c.close - c.ma5) / c.ma5;
    if (ma5Dev > 0.15) return true;
  }
  if (c.ma20 != null && c.ma20 > 0) {
    const ma20Dev = (c.close - c.ma20) / c.ma20;
    if (ma20Dev > 0.15) return true;
  }
  return false;
}

export function detectTrendPosition(
  candles: CandleWithIndicators[],
  index: number,
): TrendPosition {
  const trend = detectTrend(candles, index);
  if (trend === '盤整') return '盤整觀望';

  const pivots = findPivots(candles, index, 10);

  // 接近壓力 / 支撐閾值：3%（書本經驗值；可根據回測微調）
  const NEAR_SR_PCT = 0.03;
  const c = candles[index];

  if (trend === '多頭') {
    const consecSurge     = hasConsecLongRed(candles, index, 3);
    const blowoffReversal = hasBlowoffBlackReversal(candles, index);
    const blowoffNoRise   = hasConsecBlowoffNoRise(candles, index);
    const volPriceDiv     = hasVolumePriceDivergence(candles, index, pivots);
    const biasOverExt     = isBiasOverExtended(candles, index);
    // 2026-07-05 課程對齊（1-5「連續急漲漲幅超過 20% → 高檔爆量 → 容易反轉」）：
    // 近 20 根累計漲幅 >20% 且今日爆量（avgVol5×2）納入末升段合議
    const surgedOver20 = (() => {
      const base = candles[Math.max(0, index - 20)];
      if (!base || base.close <= 0) return false;
      const gain = c.close / base.close - 1;
      return gain > 0.20 && c.avgVol5 != null && c.avgVol5 > 0 && c.volume >= c.avgVol5 * 2;
    })();

    const endSignals = [
      consecSurge, blowoffReversal, blowoffNoRise, volPriceDiv, biasOverExt, surgedOver20,
    ].filter(Boolean).length;
    if (endSignals >= 2) return '末升段(高檔)';

    // 接近壓力區：未達末升段，但收盤已逼近近 60 根 swing high
    const swingHi = findSwingHigh(candles, index, 60);
    if (swingHi != null && swingHi > 0 && c.close >= swingHi * (1 - NEAR_SR_PCT)) {
      return '接近壓力區';
    }
    return '多頭上升段';
  } else {
    // 空頭：末跌段合議（2026-07-05 批次B修）
    // 舊判準 lowerLowCount≥5 純自創（回測-20）且全市場兩年 36,740 個空頭股日 0 觸發＝死分支
    // （findPivots 10 個 pivot 最多 ~5 個底，連 5 段底底低幾乎不可能）。
    // 改用與末升段對稱的合議判準 ≥2（課程空頭鏡像；量要求寬鬆 CH5-1「沒人買股價就跌」）：
    const consecPlunge  = hasConsecLongBlack(candles, index, 3);           // 連 3 長黑急跌
    const panicBlowoff  = hasBlowoffBlackReversal(candles, index);         // 量×2 長黑＝恐慌殺盤/竭盡
    const droppedOver20 = (() => {                                         // 近 20 根累跌 >20%（鏡像末升段 20%）
      const base = candles[Math.max(0, index - 20)];
      if (!base || base.close <= 0) return false;
      return c.close / base.close - 1 < -0.20;
    })();
    const biasOverSold = (() => {                                          // 遛狗鏡像：乖離 <-15%
      if (c.ma5 != null && c.ma5 > 0 && (c.close - c.ma5) / c.ma5 < -0.15) return true;
      if (c.ma20 != null && c.ma20 > 0 && (c.close - c.ma20) / c.ma20 < -0.15) return true;
      return false;
    })();
    const endDownSignals = [consecPlunge, panicBlowoff, droppedOver20, biasOverSold].filter(Boolean).length;
    if (endDownSignals >= 2) return '末跌段(低檔)';

    // 接近支撐區：未達末跌，但收盤已逼近近 60 根 swing low
    const swingLo = findSwingLow(candles, index, 60);
    if (swingLo != null && swingLo > 0 && c.close <= swingLo * (1 + NEAR_SR_PCT)) {
      return '接近支撐區';
    }
    return '空頭下跌段';
  }
}

// ── Six Conditions evaluator ──────────────────────────────────────────────────

/**
 * 朱老師六大進場條件（對齊《活用技術分析寶典》p.54 短線做多選股SOP）
 *
 * ① 趨勢條件：日線波浪型態符合「頭頭高、底底高」多頭架構
 * ② 均線條件：MA10、MA20 多頭排列，均線方向向上
 * ③ 股價位置：收盤在 MA10、MA20 之上，判斷初升段/主升段/末升段
 * ④ 成交量：攻擊量 ≥ 前一日 × 1.3（2倍更強）
 * ⑤ 進場K線：價漲、量增、紅K實體棒 > 2%
 * ⑥ 指標參考：MACD 綠柱縮短或紅柱延長；KD 黃金交叉向上多排
 *
 * 重要：條件 1~5 為必要條件，第6個（指標參考）為輔助確認，可後面補上
 */
export function evaluateSixConditions(
  candles: CandleWithIndicators[],
  index: number,
  params?: Partial<StrategyThresholds>,
): SixConditionsResult {
  const kdMax     = params?.kdMaxEntry      ?? 88;   // 與 BASE_THRESHOLDS 一致
  const devMax    = params?.deviationMax    ?? 0.15; // 與 BASE_THRESHOLDS 一致（15%，書本 p.568）
  const volMin    = params?.volumeRatioMin  ?? BOOK_VOL_RATIO_MIN;  // 書上p.54：前一日×1.3
  // upperShadowMax 已棄用：書本定義「長上影線 = 上影 > 實體」，不用比例門檻

  const c    = candles[index];
  const prev = index > 0 ? candles[index - 1] : null;

  // ─────────────────────────────────────────────────────────────────────────
  // ① 趨勢條件（必要）
  // ─────────────────────────────────────────────────────────────────────────
  const trendState = detectTrend(candles, index);
  const trendPass  = trendState === '多頭';
  // 盤整時附四型態外觀標籤（課程 CH1-4，純顯示）
  const consolShape = trendState === '盤整' ? classifyConsolidationShape(candles, index) : null;
  const trendDetail = trendState === '多頭'
    ? '✅ 多頭趨勢（頭頭高、底底高）'
    : trendState === '空頭'
    ? '❌ 空頭趨勢（頭頭低、底底低）—— 不宜做多'
    : consolShape
    ? `⚠️ 盤整趨勢 — ${consolShape.detail}`
    : '⚠️ 盤整趨勢（方向不明）—— 觀望';

  // ─────────────────────────────────────────────────────────────────────────
  // ③ 股價位置（必要）
  // 書上p.54：股價收盤要在MA10、MA20之上，判斷初升段/主升段/末升段
  // 合格條件（兩種擇一）：
  //   A. 回後漲：近5日曾觸及MA10支撐（回測），今日收盤回站MA5以上
  //   B. 初漲段：MA20乖離 0–devMax（剛站上月線，還沒太貴）
  // ─────────────────────────────────────────────────────────────────────────
  const stage  = detectTrendPosition(candles, index);
  const ma20   = c.ma20;
  const ma20Dev = ma20 && ma20 > 0 ? (c.close - ma20) / ma20 : null;

  // 書本 p.54 第 3 條原文：「股價收盤在 MA10、MA20 之上」
  // p.37 的 2 口訣（回後買上漲/盤整突破）+ p.749 的高勝率 6 位置是「更好的時機加分項」，不是 gate
  // （2026-04-19 用戶第二次糾正）
  const positionAboveKeyMa = c.ma10 != null && c.ma20 != null
    && c.close > c.ma10 && c.close > c.ma20;

  // Scenario A：回後買上漲（p.37 ①）— 資訊 tag
  // 書本完整版（用戶 2026-05-09 統一 detector）：
  //   多頭 + 跨 MA5 時序 + 不破前低 + 紅K 實體 ≥ 2% + 量 ≥ 前日 × 1.3 + 突破前一日最高
  //   邏輯與 B 買法 detectBreakoutEntry 完全一致（reuse 同一個 detectPullbackBuy）
  const pulledBackBuy = detectPullbackBuy(candles, index) !== null;

  // Scenario B：盤整突破（p.37 ② + Part 4 p.299「狹幅盤整 5-6 天」+ Part 7 p.488 攻擊量）
  // 2026-05-09 統一 detector：③ 加分 tag 跟 C 買法都呼叫 detectRangeBreakout 共用邏輯
  const rangeBreakout = detectRangeBreakout(candles, index) !== null;

  // 高勝率 6 位置（書本 Part 12 p.749-754）其餘 4 種 — 加分 tag，不是 gate
  const extra = detectExtraHighWinPositions(candles, index);
  const highWinTags: string[] = [];
  if (extra.bottomTrendConfirm)   highWinTags.push('🎯 打底趨勢確認');
  if (pulledBackBuy)               highWinTags.push('🎯 回後買上漲');
  if (rangeBreakout)               highWinTags.push('🎯 盤整突破');
  if (extra.maClusterBreak)        highWinTags.push('🎯 均線糾結突破');
  if (extra.strongPullbackResume)  highWinTags.push('🎯 強勢短回續攻');
  if (extra.falseBreakRebound)     highWinTags.push('🎯 假跌破反彈');

  // 4 線多排 — 結構強度升級 tag（書本 Part 4 p.279-280 + Part 12 p.749「升級做長多」）
  // 觸發：MA5 > MA10 > MA20 > MA60 且 收盤 > MA60（對齊書本 p.749「突破 60 均」原文）
  // 不擋 gate，純加分 — 給長多升級訊號用（2026-05-09 新增）
  const ma60FullAlign = c.ma5 != null && c.ma10 != null && c.ma20 != null && c.ma60 != null
    && c.ma5 > c.ma10 && c.ma10 > c.ma20 && c.ma20 > c.ma60
    && c.close > c.ma60
    // 2026-07-05 課程對齊（1-9 公式5「4 線多頭排列**向上**」）：MA20/MA60 也要向上
    && (prev?.ma20 == null || c.ma20 > prev.ma20)
    && (prev?.ma60 == null || c.ma60 >= prev.ma60);
  if (ma60FullAlign) highWinTags.push('🎯 4 線多排');

  // 書本 p.54 #3 gate：收盤在 MA10、MA20 之上；乖離 ≤ devMax（用戶設定 15%）
  const positionPass = positionAboveKeyMa && (ma20Dev === null || ma20Dev <= devMax);

  // Tier B 書本警示 tag（不擋 gate，僅顯示資訊）—— 讓用戶看到書本其他訊號
  const warnings: string[] = [];

  // MA20 乖離警示（書本 p.568「盡量避免追高」— 未量化，MA20_WARN_DEVIATION_PCT 自創）
  if (ma20Dev !== null && ma20Dev > MA20_WARN_DEVIATION_PCT) {
    warnings.push(`⚠️ MA20乖離${(ma20Dev*100).toFixed(1)}%追高警示(書p.568)`);
  }
  // 量價背離（書本 p.500-506）
  // 2026-07-05 忠實度修（CH4-5）：課程明講「**行進間**的價漲量縮＝惜售，是很好的、後面
  // 還有高點」，只有**高檔**的價漲量縮才是背離警訊 — 加高檔 gate（乖離 >5% 或已漲一倍），
  // 行進間改標良性惜售（資訊性，不帶 ⚠️）。
  const div = detectVolumePriceDivergence(candles, index);
  const divHighGate = (ma20Dev !== null && ma20Dev > 0.05)
    || detectHighPeakVolume(candles, index).positionLabel === 'doubled';
  if (div.priceUpVolDown) {
    if (divHighGate) warnings.push('⚠️ 高檔價漲量縮背離(書p.500)');
    else warnings.push('ℹ️ 行進間量縮惜售(良性,課程CH4-5:後面還有高點)');
  }
  if (div.pricePlatVolUp) warnings.push('⚠️ 價平量增停滯(書p.502)');
  if (div.priceUpVolPlat) warnings.push('⚠️ 價漲量平止漲(書p.505,出黑K才確認;出大量紅K過高反轉強)');
  // 高檔爆量 3 種判定（書本 p.493-499）+ 出貨分級語意（賠少-8 / 小修-4，純避雷顯示）
  const hpv = detectHighPeakVolume(candles, index);
  if (hpv.distributionVolume) warnings.push('⚠️ 高檔出貨量(書p.498)');
  if (hpv.luringDistribution) warnings.push('⚠️ 誘多出貨量(反彈再爆量騙進場,書p.495)');
  if ((hpv.consecutiveHighBlackK ?? 0) >= 2) warnings.push(`⚠️ 連${hpv.consecutiveHighBlackK}根高檔爆量黑K(累積出貨)`);
  if (hpv.positionLabel === 'doubled')   warnings.push('⚠️ 已漲一倍高檔(主力目標區,書p.493)');
  if (hpv.positionLabel === 'firstHead') warnings.push('⚠️ 做頭第1個頭出貨量(書p.75)');
  if (hpv.positionLabel === 'secondHead') warnings.push('⚠️ 做頭第2個頭頭頭低(書p.75)');
  // MACD 7 條細則 + 高檔背離（書本 p.540-547）
  const macd7 = detectMacdOsc7(candles, index);
  if (macd7.highPeakDiverge) warnings.push('⚠️ MACD高檔背離(書p.547)');
  if (macd7.redDivergence)   warnings.push('⚠️ MACD紅柱漸長但股價不漲(書p.540)');
  // KD 鈍化 + 峰背離（書本 p.553-559）
  if (isKdHighSaturated(candles, index)) warnings.push('⚠️ KD高檔鈍化≥80(書p.553)');
  if (detectKdPeakDivergence(candles, index)) warnings.push('⚠️ KD峰背離(書p.558)');
  // 窒息量（書本 p.525）
  if (detectChokingVolume(candles, index)) warnings.push('⚠️ 窒息量(書p.525)');
  // 一日反轉（書本 p.74-75）
  if (detectOneDayReversal(candles, index)) warnings.push('⚠️ 一日反轉訊號(書p.74)');
  // 做頭三階段（書本 p.75-76）
  const top = detectTopFormation(candles, index);
  if (top === 'secondHead') warnings.push('⚠️ 做頭第2個頭(書p.75)');
  else if (top === 'bearConfirmed') warnings.push('⚠️ 空頭反轉確認(書p.76)');
  // 布林通道進階（書本 p.572-582）
  const bb = detectBollingerSignals(candles, index);
  if (bb.sellFromUpper)   warnings.push('⚠️ 布林穿上軌賣訊(書p.575)');
  if (bb.allBandsFalling) warnings.push('⚠️ 布林3軌同向下(書p.581)');
  // 缺口警示（書本 Part 9）
  const gapUp = classifyGapUp(candles, index);
  if (gapUp === 'exhaustion') warnings.push('⚠️ 末升段竭盡缺口(書p.602)');
  if (gapUp === 'island')     warnings.push('⚠️ 島型反轉(書p.593)');
  const gaps2 = detectTwoGapsInThreeDays(candles, index);
  if (gaps2.up)   warnings.push('🎯 向上3日2缺口(書p.635，必大漲)');
  if (gaps2.down) warnings.push('⚠️ 向下3日2缺口(書p.638，必大跌)');
  // 低檔島型反彈（多頭訊號）
  const island = detectIslandReversal(candles, index, 5);
  if (island === 'bottom') warnings.push('🎯 低檔島型反轉(書p.593)');
  else if (island === 'top') warnings.push('⚠️ 高檔島型反轉(書p.607)');

  const positionDetail = (() => {
    const devStr = ma20Dev !== null ? `MA20乖離${(ma20Dev*100).toFixed(1)}%` : '';
    if (c.ma10 == null || c.ma20 == null) return '均線資料不足（需 MA10/20）';
    if (!positionAboveKeyMa) {
      return `❌ 收盤 ${c.close} 未同時站上 MA10 ${c.ma10.toFixed(1)} / MA20 ${c.ma20.toFixed(1)}`;
    }
    // 加分 tag 搬到 SixConditionsResult.highWinTags，UI 獨立區塊渲染，不再塞到 detail
    const warnStr  = warnings.length > 0 ? `｜警示：${warnings.join(' ')}` : '';
    return `✅ 收盤站上 MA10/MA20（${devStr}，${stage}${warnStr}）`;
  })();

  // ─────────────────────────────────────────────────────────────────────────
  // ⑤ 進場K線（必要）
  // 書本 p.54：進場K線要價漲、量增、紅K實體棒＞2%
  // 抓住線圖短線 20 守則 #10：進場紅 K 上影線超過 1/2 (K 線總長) 不買進
  //
  // 2026-05-09 化簡為 2 條：
  //   1. 紅 K 實體 ≥ 2%
  //   2. 收盤位置 ≥ K 線中點（closePos ≥ 0.5）
  //
  // 對紅 K 而言，closePos ≥ 0.5 數學上等價於「上影 ≤ K 線總長 × 0.5」（直接對齊 p.402 原文），
  // 移除原本「上影 ≤ 實體」的冗餘檢查（書本 K 線形態的長上影定義，但不適用「進場 K」場景）。
  // ─────────────────────────────────────────────────────────────────────────
  const bodyPct   = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  const isRedK    = c.close > c.open;
  const dayRange  = c.high - c.low;
  // 收盤在K棒上半段：(close - low)/(high - low) >= 0.5
  const closePos  = dayRange > 0 ? (c.close - c.low) / dayRange : 0.5;

  const isLongRedK  = isRedK && bodyPct >= 0.02;
  const isHighClose = closePos >= 0.5;

  const kbarPass = isLongRedK && isHighClose;
  const kbarType = isLongRedK
    ? kbarPass
      ? `✅ 長紅K（實體${(bodyPct*100).toFixed(1)}%，高收盤 ${(closePos*100).toFixed(0)}%）`
      : `⚠️ 長紅但收盤偏低/上影過長（實體${(bodyPct*100).toFixed(1)}%，收盤位置${(closePos*100).toFixed(0)}%）`
    : isRedK
    ? `⚠️ 小紅K（實體${(bodyPct*100).toFixed(1)}%，未達2%）`
    : `❌ 黑K / 不符合`;

  // ─────────────────────────────────────────────────────────────────────────
  // ② 均線條件（必要）— 書本 Part 2 p.54 第 2 條
  //   原文：「MA10、MA20 多排+向上（季線如果在上方下彎要警示）」
  //   • MA5 > MA10 > MA20 三線多排（MA5 為跨書共識，朱 p.54 只明寫 MA10/MA20）
  //   • MA10/MA20 向上
  //   • MA60 僅作「在上方下彎」壓力警示，不是 gate（書本 p.54）
  //   • p.749 的「突破 60 均 → 4 線多排」是打底完成後升級做長多的條件，非每日進場必要
  // ─────────────────────────────────────────────────────────────────────────
  const { ma5, ma10 } = c;
  const ma60 = c.ma60;
  const prevMa10 = prev?.ma10;
  const prevMa20q = prev?.ma20;
  const prevMa60 = prev?.ma60;

  const maAlign      = ma5 != null && ma10 != null && ma20 != null
    && ma5 > ma10 && ma10 > ma20;                            // 三線多排（對齊 p.54）
  // 2026-07-05 課程對齊（3-4 投影片「3 條均線方向皆向上」）：補 MA5 向上（之前只驗 MA10/20）
  const prevMa5q = prev?.ma5;
  const ma5Rising    = ma5 != null && prevMa5q != null && ma5 > prevMa5q;
  const ma10Rising   = ma10 != null && prevMa10 != null && ma10 > prevMa10;
  const ma20Rising   = ma20 != null && prevMa20q != null && ma20 > prevMa20q;

  const bullishAlign = maAlign && ma5Rising && ma10Rising && ma20Rising;

  // MA60 季線壓力警示（書本 p.54 原文「季線如果在上方下彎要警示」，非 gate）
  const ma60Pressure = ma60 != null && prevMa60 != null
    && ma60 > c.close && ma60 < prevMa60;

  // 季線動能警示（2026-07-05 批次B回測 backtest-course-research-batch Q3）：
  // 多頭股按 MA60 10 日斜率五分位，train/test 皆單調 — 最陡桶唯一正超額（+0.06/+0.41%）、
  // 走平/下彎桶 test D20 -4.72%。「多頭但季線沒在漲」＝弱勢群 → 純顯示警示，不進 gate/排序
  // （升級排序須過 backtest-unified-leaderboard 變體，另案）。課程對應 CH3-3 均線助漲力道。
  const ma60Ago = candles[index - 10]?.ma60;
  const ma60Slope10 = ma60 != null && ma60Ago != null && ma60Ago > 0 ? ma60 / ma60Ago - 1 : null;
  const ma60Stalling = ma60Slope10 != null && ma60Slope10 <= 0;

  const maAlignment = (() => {
    if (bullishAlign) {
      const base = `✅ MA5(${ma5?.toFixed(1)})>MA10(${ma10?.toFixed(1)})>MA20(${ma20?.toFixed(1)}) 三線多排，三線皆向上`;
      const warns = [
        ma60Pressure ? `⚠️ 季線 ${ma60?.toFixed(1)} 下彎在上方，靠近有壓力` : '',
        ma60Stalling ? `⚠️ 季線 10 日走平/下彎（${((ma60Slope10 ?? 0) * 100).toFixed(1)}%）— 回測弱勢群（批次B Q3），助漲力不足` : '',
      ].filter(Boolean);
      return warns.length ? `${base}（${warns.join('；')}）` : base;
    }
    if (ma5 == null || ma10 == null || ma20 == null) return '均線資料不足';
    const issues = [
      !maAlign       ? `⚠️ 三線未完全多排（MA5=${ma5.toFixed(1)} MA10=${ma10.toFixed(1)} MA20=${ma20.toFixed(1)}）` : '',
      !ma5Rising     ? `MA5 未向上(${prevMa5q?.toFixed(1)}→${ma5.toFixed(1)})` : '',
      !ma10Rising    ? `MA10 未向上(${prevMa10?.toFixed(1)}→${ma10.toFixed(1)})` : '',
      !ma20Rising    ? `MA20 未向上(${prevMa20q?.toFixed(1)}→${ma20.toFixed(1)})` : '',
    ].filter(Boolean).join('，');
    return issues || '均線多排但有問題';
  })();

  // ─────────────────────────────────────────────────────────────────────────
  // ④ 成交量（書上p.54：攻擊量 ≥ 前一日 × 1.3，2倍更強）
  // 主要判斷：當天量 ≥ 前一日 × 1.3
  // 次要判斷：量縮回檔後量增上漲
  // ─────────────────────────────────────────────────────────────────────────
  const prevDayVol = prev?.volume ?? 0;
  const volVsPrevDay = prevDayVol > 0
    ? +(c.volume / prevDayVol).toFixed(2)
    : null;
  const avgVol5 = c.avgVol5;

  // 主要：當天量 ≥ 前一日 × 1.3（書上原則）
  const attackVolume = volVsPrevDay !== null && volVsPrevDay >= volMin;

  // 次要：「量縮回檔後量增上漲」：前3日量縮（<均量），今日量增 ≥ 前日1.3x
  let isPullbackVol = false;
  if (index >= 3 && avgVol5) {
    const recentVols = [candles[index-1], candles[index-2], candles[index-3]].map(x => x.volume);
    const allLow = recentVols.every(v => v < avgVol5 * 0.9);
    const todayUp = prevDayVol > 0 && c.volume > prevDayVol * 1.3;
    isPullbackVol = allLow && todayUp;
  }

  // 2026-07-05 裁決-3（使用者拍板回歸課程）：「新鮮信號」是課程沒有的自創 gate
  //（課程 CH1-05 高勝率三條件無「第3根大量作廢」條款）— 從 gate 降級為警示 tag。
  const isFreshSignal = (() => {
    if (index < 2 || !avgVol5) return true;
    const prev1 = candles[index - 1];
    const prev2 = candles[index - 2];
    const prev1BigUp = prev1.volume >= avgVol5 * 1.3 && prev1.close > prev1.open;
    const prev2BigUp = prev2.volume >= avgVol5 * 1.3 && prev2.close > prev2.open;
    return !(prev1BigUp && prev2BigUp);
  })();

  const volumePass = attackVolume || isPullbackVol;
  const volumeDetail = volVsPrevDay !== null
    ? volumePass
      ? `✅ 成交量 ${volVsPrevDay}x 前日${isPullbackVol ? '（量縮回檔後量增）' : '（攻擊量）'}${volVsPrevDay >= 2 ? '🔥力道強' : ''}${!isFreshSignal ? '（⚠️ 已連漲帶量 2 日，第 3 棒追高風險）' : ''}`
      : `⚠️ 成交量 ${volVsPrevDay}x 前日（未達${volMin}x基準）`
    : '前日成交量資料不足';

  // ─────────────────────────────────────────────────────────────────────────
  // ⑥ 指標參考（輔助，可後面補上）
  // 書上p.55：MACD 綠柱縮短或紅柱延長；KD 黃金交叉向上多排
  // 兩者合起來等價於「OSC 數值增加」(osc > oscPrev)
  // ─────────────────────────────────────────────────────────────────────────
  const osc  = c.macdOSC;
  const oscP = prev?.macdOSC;
  const macdBull = osc != null && oscP != null && osc > oscP;

  // 書本 p.54：KD 指標黃金交叉向上多排
  //   = K 值向上（K 今日 > K 昨日）+（黃金交叉 OR 多頭排列）
  const kRising  = c.kdK != null && prev?.kdK != null && c.kdK > prev.kdK;

  // KD 黃金交叉：K 剛剛超過 D
  const kdCross  = prev != null
    && c.kdK != null && c.kdD != null
    && prev.kdK != null && prev.kdD != null
    && c.kdK > c.kdD          // 今日 K > D
    && prev.kdK <= prev.kdD;  // 昨日 K ≤ D（剛交叉）

  // KD 維持多排：K > D 且在健康區間
  const kdBull   = c.kdK != null && c.kdD != null
    && c.kdK > c.kdD
    && c.kdK >= 20
    && c.kdK <= kdMax;

  // 書本要求 K 值向上 + (金叉 OR 多排)
  const kdPass   = kRising && (kdCross || kdBull);

  const indicatorPass = macdBull || kdPass;
  // OSC 精度跟走圖副圖統一（2 位小數）— 跟 KD 精度一致
  const macdLabel = macdBull
    ? `✅ MACD 轉強(OSC ${oscP?.toFixed(2) ?? '—'}→${osc?.toFixed(2) ?? '—'})`
    : `⚠️ MACD 未轉強(OSC=${osc?.toFixed(2) ?? '—'})`;
  // KD 顯示精度跟走圖副圖統一（2 位小數）— 不要用 toFixed(0) 整數，否則 84.58 →
  // 顯示為「85」會跟走圖副圖「84.58」對不上看起來像 bug
  const indicatorDetail = [
    macdLabel,
    kdPass
      ? (kdCross
          ? `✅ KD 金叉+K值向上(K=${c.kdK?.toFixed(2)}↑D=${c.kdD?.toFixed(2)})`
          : `✅ KD 多排+K值向上(K=${c.kdK?.toFixed(2)},D=${c.kdD?.toFixed(2)})`)
      : !kRising
      ? `⚠️ K 值未向上(${prev?.kdK?.toFixed(2) ?? '—'}→${c.kdK?.toFixed(2) ?? '—'})`
      : c.kdK != null && c.kdK > kdMax
      ? `❌ KD超買(K=${c.kdK?.toFixed(2)},過高風險大)`
      : `⚠️ KD未多排(K=${c.kdK?.toFixed(2) ?? '—'},D=${c.kdD?.toFixed(2) ?? '—'})`,
  ].join('\n');

  // ─────────────────────────────────────────────────────────────────────────
  // 總分（書上順序：趨勢→均線→位置→成交量→K線→指標）
  // 條件 1~5 為必要，第6個（指標參考）為輔助
  // ─────────────────────────────────────────────────────────────────────────
  const coreConditions = [trendPass, bullishAlign, positionPass, volumePass, kbarPass]; // 必要 1~5
  const coreScore = coreConditions.filter(Boolean).length;
  const isCoreReady = coreScore === 5; // 前5個全過
  const totalScore = coreScore + (indicatorPass ? 1 : 0);

  return {
    trend:     { pass: trendPass,     state: trendState, detail: trendDetail },
    ma:        { pass: bullishAlign,  alignment: maAlignment, detail: maAlignment },
    position:  { pass: positionPass,  stage, deviation: ma20Dev, detail: positionDetail },
    volume:    { pass: volumePass,    ratio: volVsPrevDay, threshold: volMin, detail: volumeDetail },
    kbar:      { pass: kbarPass,      type: kbarType, bodyPct, closePos, detail: kbarType },
    indicator: { pass: indicatorPass, macd: macdBull, kd: kdPass, kdK: c.kdK ?? null, macdOSC: c.macdOSC ?? null, detail: indicatorDetail },
    totalScore,
    coreScore,
    isCoreReady,
    highWinTags,
  };
}
