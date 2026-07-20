/**
 * 策略 I：K 線橫盤突破進場偵測
 *
 * 朱家泓《活用技術分析寶典》Part 11-1 8 種進場位置「位置 3：等 K 線橫盤突破」（p.694）：
 *   多頭上漲中出現一根 K（錨點，課程 6-3 投影片：**第一根紅黑不管、實體大小不管**），
 *   股價維持在其高低區間「橫盤整理」，隨後大量中長紅 K 收盤突破橫盤最高點，做多。
 *
 * 對應寶典 Part 12-4「18 種空轉多祕笈圖」第 5 圖「K 線橫盤突破」（p.802）。
 *
 * 用戶 Step 2 第 4 條「K 線橫盤突破」直接源頭。
 *
 * 與位置 1（盤整突破 C）的差異：
 *   位置 1：一段較長盤整（detectTrend === '盤整'）→ 突破上頸線
 *   位置 3：短期狹幅橫盤（3-15 天，在第一根 K 上方）→ 收盤突破第一根 K 最高點
 *
 * 條件（2026-07-05 課程 CH2-3/6-3 對齊）：
 *   1. 多頭趨勢中
 *   2. 過去 3-15 根 K 線中，找一根 K 當錨點（課程 6-3：第一根紅黑不管、實體大小不管；
 *      不設實體門檻，橫盤成立與否由「後續收盤含納 + 狹幅 <5%」把關）
 *   3. 從錨點次日起到昨日，收盤維持在錨點高低之間「橫盤」（課程：收盤判定）：
 *      - 收盤不破錨點低點、收盤不過錨點高點（過了＝那天已是突破日）
 *      - 期間最高與錨點高的距離 < 5%（狹幅整理）
 *      - 至少 3 根 K（課程 CH2-3「連續三天」）
 *   4. 今日紅 K 實體 ≥ 2%（寶典 2024）
 *   5. 今日量 ≥ 前日 × 1.3
 *   6. 今日收盤突破錨點（第一根 K）最高點；跳空開盤＝最強（顯示標註）
 *
 * 不套戒律（strategyType='kline-pattern'）。
 */

import type { CandleWithIndicators } from '@/types';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import {
  BOOK_BODY_PCT_MIN, BOOK_VOL_RATIO_MIN,
  KLINE_CONSOL_MIN_DAYS, KLINE_CONSOL_MAX_DAYS,
  KLINE_CONSOL_MAX_RANGE_PCT,
} from './bookThresholds';

export interface KlineConsolidationBreakoutResult {
  isBreakout: boolean;
  anchorDate: string;          // 錨點 K 日期（課程 6-3：第一根紅黑不管、實體大小不管）
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

    // 2026-07-12 課程對齊（6-3 投影片：「第一根 K 棒紅黑不管、實體大小不管」）：
    // 移除自創的錨點實體 ≥3% 門檻（原「自創殘留」）。橫盤成立與否純由下方
    // 「後續收盤含納錨點高低 + 狹幅 <5%」把關；小實體/十字/黑K 起手的橫盤（課程原型）
    // 因此不再被漏抓。錨點若範圍過窄，後續收盤會破其高/低而自動失效，不致淪為雜訊。
    const anchorBodyPct = (Math.abs(a.close - a.open) / a.open) * 100; // 僅顯示用

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
    // 2026-07-20 第七輪：移除 `if (rangeWidthPct < 0) continue;` — 那是死碼。
    // rangeHigh 由 `let rangeHigh = a.high` 起算且迴圈只單向放大（k.high > rangeHigh 才更新），
    // 故 rangeHigh >= a.high 恆成立 → rangeWidthPct 恆 ≥ 0，該分支永遠不會執行。
    // 留著會讓後續審計誤以為「橫盤需摸到錨點高」而重複開錯誤的票（本輪就被騙過一次）。

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
