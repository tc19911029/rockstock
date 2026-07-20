/**
 * 策略 H：突破大量黑 K 進場偵測
 *
 * 朱家泓《活用技術分析寶典》Part 11-1 8 種進場位置「位置 8：等突破大量黑 K」（p.699）：
 *   多頭上漲一波後，大量黑 K 跌破前一日 K 線最低點，或跌破 MA5，
 *   隨即（3 日內）出現大量紅 K 突破大量黑 K 的最高點，做多。
 *
 * 同時對應寶典 Part 12-4「18 種空轉多祕笈圖」第 9 圖「突破大量黑 K 買進」（p.806）。
 *
 * 用戶 Step 2 第 5 條「過大量黑 K 高」直接源頭。
 *
 * 條件：
 *   1. 多頭趨勢中（detectTrend === '多頭'）
 *   2. 過去 3 日內出現「大量黑 K」：黑 K + 量 ≥ 前日 ×1.3 + (跌破前一日 K 低 OR 跌破 MA5)
 *   3. 今日紅 K 實體 ≥ 2%
 *   4. 今日量 ≥ 前日 × 1.3
 *   5. 今日收盤突破大量黑 K 的最高點
 *
 * 不套戒律（strategyType='kline-pattern'）— 書本 Part 11-1 是直接列出的進場位置。
 */

import type { CandleWithIndicators } from '@/types';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import {
  BOOK_BODY_PCT_MIN, BOOK_VOL_RATIO_MIN,
  BLACKK_MIN_BODY_PCT, BLACKK_MIN_VOL_RATIO, BLACKK_MAX_DAYS_AFTER,
} from './bookThresholds';

export interface BlackKBreakoutResult {
  isBlackKBreakout: boolean;
  blackKHigh: number;          // 大量黑 K 的最高點（被突破的目標）
  blackKLow: number;           // 大量黑 K 最低點（停損參考）
  blackKDate: string;          // 大量黑 K 的日期
  blackKVolumeRatio: number;   // 大量黑 K 的量比
  bodyPct: number;             // 今日紅 K 實體
  volumeRatio: number;         // 今日量比
  daysSinceBlackK: number;     // 距大量黑 K 幾天（≤ 3）
  detail: string;
}

// 書本門檻單一事實來源：lib/analysis/bookThresholds.ts
const MAX_DAYS_AFTER_BLACK_K = BLACKK_MAX_DAYS_AFTER;   // 書本「3 日內」
const MIN_BLACK_K_BODY_PCT = BLACKK_MIN_BODY_PCT;       // 黑 K 至少 1.5% 才算「大」
const MIN_BLACK_K_VOL_RATIO = BLACKK_MIN_VOL_RATIO;     // 黑 K 量 ≥ 前日 × 1.3 才算「大量」

interface BlackKEvent {
  index: number;
  high: number;
  low: number;
  date: string;
  volumeRatio: number;
}

/**
 * 在 [idx-MAX_DAYS_AFTER_BLACK_K, idx-1] 區間內找最近一根「大量黑 K」。
 *
 * 「大量黑 K」定義：
 *   黑 K（close < open）
 *   實體 ≥ 1.5%
 *   量 ≥ 前日 × 1.3
 *   且：跌破前一日 K 線最低點 OR 跌破 MA5
 */
function findRecentLargeVolumeBlackK(
  candles: CandleWithIndicators[],
  idx: number,
): BlackKEvent | null {
  // 從最近往前找（idx-1 → idx-MAX_DAYS_AFTER_BLACK_K）
  // 找到第一根符合條件就回傳（最近的一根，書本「隨即（3 日內）」）
  const oldest = Math.max(1, idx - MAX_DAYS_AFTER_BLACK_K);
  let mostRecent: BlackKEvent | null = null;

  for (let i = idx - 1; i >= oldest; i--) {
    const cd = candles[i];
    const prev = candles[i - 1];
    if (!cd || !prev || prev.volume <= 0 || cd.open <= 0) continue;

    // 黑 K
    if (cd.close >= cd.open) continue;

    // 實體 ≥ MIN_BLACK_K_BODY_PCT
    const bodyPct = ((cd.open - cd.close) / cd.open) * 100;
    if (bodyPct < MIN_BLACK_K_BODY_PCT) continue;

    // 量 ≥ 前日 × MIN_BLACK_K_VOL_RATIO
    const volRatio = cd.volume / prev.volume;
    if (volRatio < MIN_BLACK_K_VOL_RATIO) continue;

    // 跌破前一日 K 低 OR 跌破 MA5
    const breakPrevLow = cd.close < prev.low;
    const breakMA5 = cd.ma5 != null && cd.close < cd.ma5;
    if (!breakPrevLow && !breakMA5) continue;

    // 取最近一根（迴圈是由近往遠，找到就 break）
    mostRecent = {
      index: i,
      high: cd.high,
      low: cd.low,
      date: cd.date,
      volumeRatio: volRatio,
    };
    break;
  }

  return mostRecent;
}

/**
 * 偵測位置 8 突破大量黑 K。
 */
export function detectBlackKBreakout(
  candles: CandleWithIndicators[],
  idx: number,
): BlackKBreakoutResult | null {
  if (idx < 21) return null;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.volume <= 0 || c.open <= 0) return null;

  // 1. 必須在多頭趨勢中（書本「多頭上漲一波後」）
  if (detectTrend(candles, idx) !== '多頭') return null;

  // 1b. 2026-07-05 回測-15 按課程（6-7 投影片條 02）：「MA20 月線要維持上揚」顯式 gate
  if (c.ma20 != null && prev.ma20 != null && c.ma20 < prev.ma20) return null;

  // 1c. 2026-07-05 回測-6 按課程（6-7）：「這個位置只在**飆股**出現」— 飆股前提
  //（⚠️ 自創量化：近 10 根漲幅 ≥10% ＝ 回檔前急漲的證據。
  //  不驗「近3日 MA5 上」— L 的型態本身就是「大量黑K回檔」，回檔日必然破5均，驗了自相矛盾）
  const base10 = candles[Math.max(0, idx - 10)];
  const surging = base10 != null && base10.close > 0 && c.close / base10.close - 1 >= 0.10;
  if (!surging) return null;

  // 2. 找最近 3 日內的大量黑 K
  const blackK = findRecentLargeVolumeBlackK(candles, idx);
  if (!blackK) return null;

  // 3. 今日紅 K
  if (c.close <= c.open) return null;

  // 4. 今日紅 K 實體 ≥ 2%
  const bodyPct = ((c.close - c.open) / c.open) * 100;
  if (bodyPct < BOOK_BODY_PCT_MIN) return null;

  // 5. 今日量比 ≥ 1.3
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < BOOK_VOL_RATIO_MIN) return null;

  // 6. 今日收盤突破大量黑 K 最高點
  if (c.close <= blackK.high) return null;

  // 7. 首次突破（課程 CH6-7「次日或 3 天內**出現**大量中長紅K收盤突破」＝狀態轉換，不是位置比較）
  //
  // 2026-07-20 第七輪新增，**已通過回測才上**（backtest-r7-ml-freshness-gate）：
  //   1,064 筆訊號、gate 砍 33%。fresh vs stale 四格全部 fresh 較優、不翻面：
  //     train fresh D20 +1.46% vs stale −0.40%；test fresh −1.15% vs stale −2.43%
  //   切三段 D20 差值 +1.28 / +1.63 / +1.64，穩定。
  // ⚠️ 誠實揭露：這是**避雷型改善不是 alpha** — fresh 組自己在 test 仍是負超額，
  //   只是避開更爛的子集（符合本專案「edge 在避雷不在選股」的既有結論）。
  // ⚠️ 同批測的 M 買法同 gate **被否決**（test D20 翻面 −1.22%），故只加在 L。
  // 實質效果＝黑K後第 2、3 天若昨天收盤已經突破過就不追（D+1 依定義不可能 stale）。
  if (prev.close > blackK.high) return null;

  const daysSinceBlackK = idx - blackK.index;

  return {
    isBlackKBreakout: true,
    blackKHigh: blackK.high,
    blackKLow: blackK.low,
    blackKDate: blackK.date,
    blackKVolumeRatio: blackK.volumeRatio,
    bodyPct,
    volumeRatio,
    daysSinceBlackK,
    detail:
      `突破大量黑 K（${blackK.date} 大量黑 K 高 ${blackK.high.toFixed(1)} 量比×${blackK.volumeRatio.toFixed(2)}，` +
      `${daysSinceBlackK} 日後紅 K 突破：實體 ${bodyPct.toFixed(2)}%＋量×${volumeRatio.toFixed(2)}＋收盤 ${c.close.toFixed(1)}）`,
  };
}
