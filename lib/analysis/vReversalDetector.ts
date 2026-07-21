/**
 * V 形反轉偵測（F 買法）— 忠於朱家泓《理財達人秀》第 57 集口述「八個字四個條件」
 *
 * 老師四關（逐字稿校正 2026-07-21，t1WlDpjzJ7A）：
 *   1. 急跌（連續下跌）：在弱勢股找，連跌 3 天以上、且從段高累積跌 ≥ 20%（跌得深才值得搶）
 *   2. 底部爆量：低檔急跌段「看到一支爆大量」= 大錢在底部進場（爆量在低檔那根，不是突破日）
 *   3. 止跌訊號：隔天不再跌，出現「變盤線（十字/紡錘/長下影）或紅K」→ 止跌
 *   4. 過高進場：再隔天紅K「收盤突破前一根K棒高點」= 型態確認點（進場）
 *
 * 與舊版差異（fidelity 修正）：
 *   - 爆量從「突破日」移回「低檔那根」（老師：爆量在底部，突破日只要紅K過高）
 *   - 止跌訊號從「只認變盤線」放寬成「變盤線 或 紅K」（老師原話：或者是紅K）
 *   - 連跌跌幅門檻 10% → 20%（老師：急跌 20% 以上才值得搶）
 *   - 突破日不再強制帶量 ×1.5（老師只要求收盤過前K高）
 *
 * 「止跌守住（不破止跌低）」保留為結構防呆：老師說「爆完量還繼續跌 還是不會轉」，
 * 止跌本來就隱含要守住低點，否則不算真止跌。
 *
 * 不限大盤趨勢（V 形反轉本來就在空頭/弱勢中發生），不看均線（老師：搶反彈跟均線無關）。
 */

import type { CandleWithIndicators } from '@/types';

export type StopBarShape = '長下影' | '十字' | '紡錘' | '紅K';

export interface VReversalResult {
  isVReversal: boolean;
  /** 止跌線距今幾根前（1 ~ 15） */
  stopBarOffset: number;
  /** 止跌線型態（變盤線三型 或 紅K） */
  stopBarShape: StopBarShape;
  /** 止跌線 low（= V 底，lockwatch 結構失效判定用） */
  stopBarLow: number;
  /** 止跌線之前觀察窗的下跌天數 */
  precedingDownDays: number;
  /** 段首高 → 止跌線低 的跌幅 % */
  precedingDrop: number;
  /** 底部爆量倍數（低檔急跌段最大量 / 段前均量） */
  bottomVolRatio: number;
  /** 底部爆量那根距今幾根前 */
  bottomVolOffset: number;
  /** 今日紅 K 實體 % */
  bodyPct: number;
  /** 前一根 K 高（突破參考） */
  prevHigh: number;
  detail: string;
}

// 書本門檻單一事實來源：lib/analysis/bookThresholds.ts
import {
  VREVERSAL_MIN_DOWN_DAYS as MIN_DOWN_DAYS,
  VREVERSAL_MIN_DROP_PCT as MIN_DROP_PCT,
  VREVERSAL_VOL_MULT as BOTTOM_VOL_MULT,
  BOOK_BODY_PCT_MIN,
} from './bookThresholds';

const LOOKBACK_STOP_BAR = 15; // 止跌線搜尋距離（允許止跌等待多天）
const PRE_DROP_WINDOW = 6;    // 止跌線之前的下跌段觀察窗（含止跌線當天）
const VOL_BASELINE_WINDOW = 5; // 底部爆量的比較基準：急跌段之前 5 根均量

/** 判斷 K 棒是否為變盤線（十字 / 紡錘 / 長下影） */
function classifyReversalShape(c: CandleWithIndicators): StopBarShape | null {
  if (c.open <= 0) return null;
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range <= 0) return null;
  const lowerShadow = Math.min(c.open, c.close) - c.low;
  const bodyPct = body / c.open;

  if (bodyPct < 0.005) return '十字';
  if (body > 0 && lowerShadow > body * 2 && lowerShadow / range > 0.5) return '長下影';
  if (body / range < 0.3) return '紡錘';
  return null;
}

/**
 * 判斷止跌線型態：老師「止跌訊號 = 變盤線 或 紅K」。
 * 變盤線優先分類（十字/紡錘/長下影），否則若為紅K（收 > 開）視為止跌紅K。
 */
function classifyStopBar(c: CandleWithIndicators): StopBarShape | null {
  const shape = classifyReversalShape(c);
  if (shape) return shape;
  if (c.open > 0 && c.close > c.open) return '紅K';
  return null;
}

/** V 反轉「結構部分」結果（連跌 + 底部爆量 + 止跌線 + 止跌守住），不含進場 K 條件 */
export interface VReversalStructure {
  stopBarOffset: number;
  stopBarShape: StopBarShape;
  stopBarLow: number;
  precedingDownDays: number;
  precedingDrop: number;
  bottomVolRatio: number;
  bottomVolOffset: number;
}

/**
 * 只跑 V 反轉的「結構」四條件（連跌 + 底部爆量 + 止跌線 + 止跌守住），
 * 不檢查進場 K（今日紅K/過高）。
 *
 * 用途：UI panel 顯示「結構已成立但今日還沒過高」的精確狀態。
 * detectVReversal 內部 reuse 此函式 (DRY)。
 */
export function detectVReversalStructure(
  candles: CandleWithIndicators[],
  idx: number,
): VReversalStructure | null {
  if (idx < LOOKBACK_STOP_BAR + PRE_DROP_WINDOW + VOL_BASELINE_WINDOW) return null;

  for (let k = 1; k <= LOOKBACK_STOP_BAR; k++) {
    const sb = candles[idx - k];
    if (!sb) continue;

    const shape = classifyStopBar(sb);
    if (!shape) continue;

    // (a) 連續下跌：止跌線含當天近 N 天下跌 ≥ 3 天 且 段高 → 止跌線低 跌幅 ≥ 門檻
    const preSeg = candles.slice(idx - k - PRE_DROP_WINDOW + 1, idx - k + 1);
    if (preSeg.length < PRE_DROP_WINDOW) continue;
    let downDays = 0;
    for (let i = 1; i < preSeg.length; i++) {
      if (preSeg[i].close < preSeg[i - 1].close) downDays++;
    }
    if (downDays < MIN_DOWN_DAYS) continue;
    const segHigh = Math.max(...preSeg.map(c => c.high));
    if (segHigh <= 0 || sb.low <= 0) continue;
    const drop = ((segHigh - sb.low) / segHigh) * 100;
    if (drop < MIN_DROP_PCT) continue;

    // (b) 底部爆量：急跌段（preSeg）中某根量 ≥ 段前 5 根均量 × 門檻（老師：低檔看到一支爆大量）
    const baseSeg = candles
      .slice(idx - k - PRE_DROP_WINDOW + 1 - VOL_BASELINE_WINDOW, idx - k - PRE_DROP_WINDOW + 1)
      .map(c => c.volume)
      .filter(v => v > 0);
    if (baseSeg.length < 3) continue;
    const baseVol = baseSeg.reduce((a, b) => a + b, 0) / baseSeg.length;
    if (baseVol <= 0) continue;
    let bottomVolRatio = 0;
    let bottomVolOffset = k;
    for (let i = 0; i < preSeg.length; i++) {
      const ratio = preSeg[i].volume / baseVol;
      if (ratio > bottomVolRatio) {
        bottomVolRatio = ratio;
        bottomVolOffset = idx - (idx - k - PRE_DROP_WINDOW + 1 + i);
      }
    }
    if (bottomVolRatio < BOTTOM_VOL_MULT) continue;

    // (c) 止跌守住：止跌線後到今日前 low 不跌破止跌線 low（k=1 時此段為空，自動通過）
    let brokeLow = false;
    for (let i = idx - k + 1; i < idx; i++) {
      if (candles[i].low < sb.low) {
        brokeLow = true;
        break;
      }
    }
    if (brokeLow) continue;

    return {
      stopBarOffset: k,
      stopBarShape: shape,
      stopBarLow: sb.low,
      precedingDownDays: downDays,
      precedingDrop: drop,
      bottomVolRatio,
      bottomVolOffset,
    };
  }
  return null;
}

export function detectVReversal(
  candles: CandleWithIndicators[],
  idx: number,
): VReversalResult | null {
  if (idx < LOOKBACK_STOP_BAR + PRE_DROP_WINDOW + VOL_BASELINE_WINDOW) return null;
  const today = candles[idx];
  const prev = candles[idx - 1];
  if (!today || !prev || today.open <= 0) return null;

  // ── 進場 K 條件（今日）：紅 K + 實體 ≥ 2% + 收盤 > 前 K 高（老師：只要紅K過高，不強制帶量）──
  if (today.close <= today.open) return null;
  const bodyPct = ((today.close - today.open) / today.open) * 100;
  if (bodyPct < BOOK_BODY_PCT_MIN) return null;
  if (today.close <= prev.high) return null;

  // ── 結構（連跌 + 底部爆量 + 止跌線 + 止跌守住）──
  const structure = detectVReversalStructure(candles, idx);
  if (!structure) return null;

  return {
    isVReversal: true,
    ...structure,
    bodyPct,
    prevHigh: prev.high,
    detail:
      `V 形反轉（${structure.stopBarOffset} 根前${structure.stopBarShape}止跌、` +
      `之前${structure.precedingDownDays}/${PRE_DROP_WINDOW - 1}天跌${structure.precedingDrop.toFixed(1)}%、` +
      `底部爆量×${structure.bottomVolRatio.toFixed(1)}(${structure.bottomVolOffset}根前)、` +
      `止跌${structure.stopBarOffset - 1}天未破低 ${structure.stopBarLow.toFixed(2)}、` +
      `今日紅K +${bodyPct.toFixed(1)}% 收盤突破前K高 ${prev.high.toFixed(2)}）`,
  };
}
