/**
 * 策略 I：K 線橫盤突破進場偵測
 *
 * 朱家泓《活用技術分析寶典》Part 11-1 8 種進場位置「位置 3：等 K 線橫盤突破」（p.694）：
 *   多頭中長紅 K 上漲後，股價維持在這根紅 K 上方「橫盤整理」，
 *   隨後再大量中長紅 K 突破橫盤最高點，做多。
 *
 * 對應寶典 Part 12-4「18 種空轉多祕笈圖」第 5 圖「K 線橫盤突破」（p.802）。
 *
 * 用戶 Step 2 第 4 條「K 線橫盤突破」直接源頭。
 *
 * 與位置 1（盤整突破 C）的差異：
 *   位置 1：一段較長盤整（detectTrend === '盤整'）→ 突破上頸線
 *   位置 3：短期狹幅橫盤（5-15 天，在中長紅 K 上方）→ 突破橫盤最高點
 *
 * 條件：
 *   1. 多頭趨勢中
 *   2. 過去 5-15 根 K 線中，可找到一根「中長紅 K」當錨點：
 *      - 紅 K 實體 ≥ 3%（書本「中長紅」定義）
 *   3. 從錨點次日起到昨日，股價維持在錨點之上「橫盤」：
 *      - 期間最低 ≥ 錨點低點（不破錨點）
 *      - 期間最高與錨點高的距離 < 5%（狹幅整理）
 *      - 至少 4 根 K（5 天起算）
 *   4. 今日紅 K 實體 ≥ 2%（寶典 2024）
 *   5. 今日量 ≥ 前日 × 1.3
 *   6. 今日收盤突破橫盤期間最高點
 *
 * 不套戒律（strategyType='kline-pattern'）。
 */

import type { CandleWithIndicators } from '@/types';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import {
  BOOK_BODY_PCT_MIN, BOOK_VOL_RATIO_MIN,
  KLINE_CONSOL_MIN_DAYS, KLINE_CONSOL_MAX_DAYS,
  KLINE_CONSOL_ANCHOR_BODY_PCT, KLINE_CONSOL_MAX_RANGE_PCT,
} from './bookThresholds';

export interface KlineConsolidationBreakoutResult {
  isBreakout: boolean;
  anchorDate: string;          // 中長紅 K 錨點日期
  anchorHigh: number;          // 錨點 K 最高
  anchorLow: number;           // 錨點 K 最低（停損參考）
  anchorBodyPct: number;       // 錨點實體 %
  rangeHigh: number;           // 橫盤期間最高（被突破的目標）
  rangeLow: number;            // 橫盤期間最低
  rangeWidthPct: number;       // 橫盤幅度（rangeHigh / anchorHigh - 1）
  consolidationDays: number;   // 橫盤天數（含錨點次日至昨日）
  bodyPct: number;             // 今日紅 K 實體
  volumeRatio: number;         // 今日量比
  detail: string;
}

// 書本門檻單一事實來源：lib/analysis/bookThresholds.ts
const MIN_CONSOL_DAYS = KLINE_CONSOL_MIN_DAYS;       // 至少 3 根橫盤 K（課程 CH2-3「連續三天」，2026-07-05 裁決 4→3）
const MAX_CONSOL_DAYS = KLINE_CONSOL_MAX_DAYS;       // 最多 15 根（更久就接近位置 1 盤整突破）
const MIN_ANCHOR_BODY_PCT = KLINE_CONSOL_ANCHOR_BODY_PCT;   // 中長紅 K：實體 ≥ 3%（寶典 Part 4-1「長紅」）
const MAX_RANGE_WIDTH_PCT = KLINE_CONSOL_MAX_RANGE_PCT;     // 橫盤狹幅：高低差 / 錨點高 < 5%

interface AnchorCandidate {
  index: number;
  high: number;
  low: number;
  date: string;
  bodyPct: number;
}

/**
 * 在 [idx-MAX_CONSOL_DAYS-1, idx-MIN_CONSOL_DAYS-1] 區間內搜尋「中長紅 K 錨點」：
 *   錨點之後到昨日（idx-1）必須形成狹幅橫盤。
 *
 * 回傳第一個（最近的）符合條件的錨點。
 */
function findAnchorAndRange(
  candles: CandleWithIndicators[],
  idx: number,
): {
  anchor: AnchorCandidate;
  rangeHigh: number;
  rangeLow: number;
  rangeWidthPct: number;
  consolidationDays: number;
} | null {
  // 從近往遠找，錨點最近不能晚於 idx-MIN_CONSOL_DAYS-1
  // 例：MIN=4 → 錨點最近 idx-5（之後 idx-4..idx-1 共 4 根橫盤 + idx 突破）
  const newest = idx - MIN_CONSOL_DAYS - 1;
  const oldest = Math.max(0, idx - MAX_CONSOL_DAYS - 1);

  for (let anchorIdx = newest; anchorIdx >= oldest; anchorIdx--) {
    const a = candles[anchorIdx];
    if (!a || a.open <= 0) continue;

    // 2026-07-05 課程對齊（6-3）：「第一根 K 棒紅黑不管」— 拿掉紅K限制，改看實體大小
    //（實體門檻保留 ⚠️ 自創殘留，防每根小K都成錨點）
    const anchorBodyPct = (Math.abs(a.close - a.open) / a.open) * 100;
    if (anchorBodyPct < MIN_ANCHOR_BODY_PCT) continue;

    // 檢查 anchorIdx+1 .. idx-1 的橫盤：
    //   2026-07-05 課程對齊（6-3 逐字稿「聽清楚是**收盤**沒有破」）：
    //   「不破錨點低點/不過錨點高點」都用**收盤**判定（舊版用影線 low 判破=盤中刺破就作廢）
    //   橫盤日「收盤過錨點高」＝那天就是突破日 → 這個窗不成立（避免突破價被墊高）
    let rangeHigh = a.high;
    let rangeLow = a.low;
    let valid = true;

    for (let i = anchorIdx + 1; i < idx; i++) {
      const k = candles[i];
      if (!k) { valid = false; break; }
      // 收盤不可跌破錨點低點（課程收盤判定）
      if (k.close < a.low) { valid = false; break; }
      // 收盤過錨點高 → 該日已是突破日，此錨點窗作廢（課程：收盤過第一根高點＝突破）
      if (k.close > a.high) { valid = false; break; }
      if (k.high > rangeHigh) rangeHigh = k.high;
      if (k.low < rangeLow) rangeLow = k.low;
    }

    if (!valid) continue;

    // 狹幅整理：rangeHigh 相對 anchorHigh 不可超過 MAX_RANGE_WIDTH_PCT
    const rangeWidthPct = ((rangeHigh - a.high) / a.high) * 100;
    if (rangeWidthPct > MAX_RANGE_WIDTH_PCT) continue;
    if (rangeWidthPct < 0) continue; // 整理期間連錨點高都沒摸到 → 不算橫盤

    const consolidationDays = idx - anchorIdx - 1;

    return {
      anchor: {
        index: anchorIdx,
        high: a.high,
        low: a.low,
        date: a.date,
        bodyPct: anchorBodyPct,
      },
      rangeHigh,
      rangeLow,
      rangeWidthPct,
      consolidationDays,
    };
  }

  return null;
}

/**
 * 偵測位置 3 K 線橫盤突破。
 */
export function detectKlineConsolidationBreakout(
  candles: CandleWithIndicators[],
  idx: number,
): KlineConsolidationBreakoutResult | null {
  if (idx < MAX_CONSOL_DAYS + 2) return null;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.volume <= 0 || c.open <= 0) return null;

  // 1. 多頭趨勢
  if (detectTrend(candles, idx) !== '多頭') return null;

  // 2. 找錨點 + 橫盤區間
  const found = findAnchorAndRange(candles, idx);
  if (!found) return null;

  // 3. 今日紅 K
  if (c.close <= c.open) return null;

  // 4. 今日紅 K 實體 ≥ 2%
  const bodyPct = ((c.close - c.open) / c.open) * 100;
  if (bodyPct < BOOK_BODY_PCT_MIN) return null;

  // 5. 量比 ≥ 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < BOOK_VOL_RATIO_MIN) return null;

  // 6. 收盤突破錨點（第一根 K）最高點 — 2026-07-05 課程對齊（6-3）：
  // 突破判準＝「收盤過第一根K棒的最高點」，不是過含影線的區間最高（舊版突破價被墊高）。
  const gapUp = c.open > prev.high; // 課程：「還跳空過，這是最強的進場位置」（顯示用）
  if (c.close <= found.anchor.high) return null;

  return {
    isBreakout: true,
    anchorDate: found.anchor.date,
    anchorHigh: found.anchor.high,
    anchorLow: found.anchor.low,
    anchorBodyPct: found.anchor.bodyPct,
    rangeHigh: found.rangeHigh,
    rangeLow: found.rangeLow,
    rangeWidthPct: found.rangeWidthPct,
    consolidationDays: found.consolidationDays,
    bodyPct,
    volumeRatio,
    detail:
      `K 線橫盤突破（${found.anchor.date} 錨點K 高 ${found.anchor.high.toFixed(2)} 實體 ${found.anchor.bodyPct.toFixed(2)}%，` +
      `${found.consolidationDays} 天橫盤幅度 ${found.rangeWidthPct.toFixed(2)}%，` +
      `今日收盤突破錨點高 ${found.anchor.high.toFixed(2)}：實體 ${bodyPct.toFixed(2)}%＋量×${volumeRatio.toFixed(2)}` +
      `${gapUp ? '＋跳空突破（課程：最強進場位置）' : ''}）`,
  };
}
