/**
 * 研究專用變體：K 線橫盤突破門檻 + 假突破過濾（C18，缺口 進場-13 / 進場-11）
 *
 * ⚠️ RESEARCH-ONLY — 預設 OFF，不進生產掃描鏈路。
 *    生產偵測器 = lib/analysis/klineConsolidationBreakout.ts（位元不變）。
 *    本檔只供 scripts/backtest-kline-consol-variants.ts 對照組使用，
 *    嚴禁被 MarketScanner / ScanPipeline / applyPanelFilter / v12Signals import。
 *
 * 對齊朱家泓書本缺口：
 *   進場-13（橫盤突破門檻對齊）：
 *     - 書本橫盤定義「連續 ≥3 天」；生產拉到 4 → 變體可放寬到 3。
 *     - 書本第一根 K「紅黑皆可」；生產要求中長紅錨點（會排除黑 K 起手的橫盤）→
 *       變體允許「中長黑」也能當錨點（取實體絕對值 ≥ 門檻）。
 *     - 跳空突破未加權；變體可對「跳空向上突破」放寬量比門檻（跳空本身=強勢）。
 *   進場-11（假突破過濾）：
 *     - 書本 1/2 價最核心應用＝判假突破：突破後 1~2 根若用黑 K 收盤跌破
 *       「突破長紅 K 的 1/2 價」→ 視為假突破。
 *     - detectFalseBreakout(candles, breakoutIdx) 在突破日後檢查 1~2 根，
 *       回 true = 假突破（該筆進場應剔除）。
 */

import type { CandleWithIndicators } from '@/types';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import {
  BOOK_BODY_PCT_MIN, BOOK_VOL_RATIO_MIN,
  KLINE_CONSOL_MIN_DAYS, KLINE_CONSOL_MAX_DAYS,
  KLINE_CONSOL_ANCHOR_BODY_PCT, KLINE_CONSOL_MAX_RANGE_PCT,
} from '@/lib/analysis/bookThresholds';

export interface KlineConsolVariantOptions {
  /** 橫盤最少天數（生產 4；書本 ≥3 → 變體可設 3）*/
  minConsolDays: number;
  /** 橫盤最多天數（沿用生產 15）*/
  maxConsolDays: number;
  /** 錨點實體門檻 %（沿用生產 3）*/
  anchorBodyPct: number;
  /** 錨點是否允許「中長黑 K」（書本紅黑皆可 → true）。false = 僅紅 K（同生產）*/
  anchorAllowBlack: boolean;
  /** 橫盤狹幅上限 %（沿用生產 5）*/
  maxRangeWidthPct: number;
  /** 今日突破 K 實體門檻 %（沿用生產 BOOK_BODY_PCT_MIN=2）*/
  breakoutBodyPct: number;
  /** 今日量比門檻 vs 前日（沿用生產 BOOK_VOL_RATIO_MIN=1.3）*/
  volRatioMin: number;
  /**
   * 跳空加權：今日「跳空向上」突破（today.low > prev.high）時，
   * 量比門檻放寬係數（1 = 不加權 / 同生產；0.8 = 跳空時量比門檻打 8 折）。
   * 跳空本身=強勢缺口，書本視為更可信的突破。
   */
  gapVolRelief: number;
}

export const PRODUCTION_BASELINE: KlineConsolVariantOptions = {
  minConsolDays: KLINE_CONSOL_MIN_DAYS,          // 4
  maxConsolDays: KLINE_CONSOL_MAX_DAYS,          // 15
  anchorBodyPct: KLINE_CONSOL_ANCHOR_BODY_PCT,   // 3
  anchorAllowBlack: false,                       // 僅紅 K
  maxRangeWidthPct: KLINE_CONSOL_MAX_RANGE_PCT,  // 5
  breakoutBodyPct: BOOK_BODY_PCT_MIN,            // 2
  volRatioMin: BOOK_VOL_RATIO_MIN,               // 1.3
  gapVolRelief: 1,                               // 不加權
};

export interface KlineConsolVariantResult {
  isBreakout: boolean;
  anchorDate: string;
  anchorHigh: number;
  anchorLow: number;
  anchorBodyPct: number;       // 實體絕對值（黑 K 為正）
  anchorIsRed: boolean;
  rangeHigh: number;
  rangeLow: number;
  rangeWidthPct: number;
  consolidationDays: number;
  bodyPct: number;
  volumeRatio: number;
  isGapUp: boolean;            // 今日跳空向上突破
}

interface AnchorCandidate {
  index: number;
  high: number;
  low: number;
  date: string;
  bodyPct: number;   // 絕對值
  isRed: boolean;
}

function findAnchorAndRange(
  candles: CandleWithIndicators[],
  idx: number,
  o: KlineConsolVariantOptions,
): {
  anchor: AnchorCandidate;
  rangeHigh: number;
  rangeLow: number;
  rangeWidthPct: number;
  consolidationDays: number;
} | null {
  const newest = idx - o.minConsolDays - 1;
  const oldest = Math.max(0, idx - o.maxConsolDays - 1);

  for (let anchorIdx = newest; anchorIdx >= oldest; anchorIdx--) {
    const a = candles[anchorIdx];
    if (!a || a.open <= 0) continue;

    const isRed = a.close > a.open;
    const isBlack = a.close < a.open;
    // 錨點型態：紅 K 永遠可；黑 K 僅當 anchorAllowBlack 開啟
    if (!isRed && !(o.anchorAllowBlack && isBlack)) continue;

    const anchorBodyPct = (Math.abs(a.close - a.open) / a.open) * 100;
    if (anchorBodyPct < o.anchorBodyPct) continue;

    // 橫盤基準：用錨點 K 的 high/low 當區間起點
    let rangeHigh = a.high;
    let rangeLow = a.low;
    let valid = true;

    for (let i = anchorIdx + 1; i < idx; i++) {
      const k = candles[i];
      if (!k) { valid = false; break; }
      if (k.low < a.low) { valid = false; break; }   // 不破錨點低點
      if (k.high > rangeHigh) rangeHigh = k.high;
      if (k.low < rangeLow) rangeLow = k.low;
    }
    if (!valid) continue;

    const rangeWidthPct = ((rangeHigh - a.high) / a.high) * 100;
    if (rangeWidthPct > o.maxRangeWidthPct) continue;
    if (rangeWidthPct < 0) continue;

    const consolidationDays = idx - anchorIdx - 1;
    return {
      anchor: { index: anchorIdx, high: a.high, low: a.low, date: a.date, bodyPct: anchorBodyPct, isRed },
      rangeHigh, rangeLow, rangeWidthPct, consolidationDays,
    };
  }
  return null;
}

/**
 * 變體版 K 線橫盤突破偵測（research-only）。
 * o = PRODUCTION_BASELINE 時，行為與生產 detectKlineConsolidationBreakout 等價。
 */
export function detectKlineConsolBreakoutVariant(
  candles: CandleWithIndicators[],
  idx: number,
  o: KlineConsolVariantOptions,
): KlineConsolVariantResult | null {
  if (idx < o.maxConsolDays + 2) return null;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.volume <= 0 || c.open <= 0) return null;

  if (detectTrend(candles, idx) !== '多頭') return null;

  const found = findAnchorAndRange(candles, idx, o);
  if (!found) return null;

  if (c.close <= c.open) return null;   // 今日仍要紅 K 突破

  const bodyPct = ((c.close - c.open) / c.open) * 100;
  if (bodyPct < o.breakoutBodyPct) return null;

  const isGapUp = c.low > prev.high;
  // 跳空加權：跳空向上時量比門檻放寬
  const effectiveVolMin = isGapUp ? o.volRatioMin * o.gapVolRelief : o.volRatioMin;
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < effectiveVolMin) return null;

  if (c.close <= found.rangeHigh) return null;   // 收盤突破橫盤最高

  return {
    isBreakout: true,
    anchorDate: found.anchor.date,
    anchorHigh: found.anchor.high,
    anchorLow: found.anchor.low,
    anchorBodyPct: found.anchor.bodyPct,
    anchorIsRed: found.anchor.isRed,
    rangeHigh: found.rangeHigh,
    rangeLow: found.rangeLow,
    rangeWidthPct: found.rangeWidthPct,
    consolidationDays: found.consolidationDays,
    bodyPct,
    volumeRatio,
    isGapUp,
  };
}

/**
 * 進場-11 假突破過濾（research-only）。
 *
 * 書本 1/2 價判假突破：突破日（breakoutIdx）為一根長紅 K，其「1/2 價」=
 *   (high + low) / 2。突破後 lookahead（1~2）根內，若出現「黑 K 且收盤跌破
 *   突破長紅 K 的 1/2 價」→ 判為假突破。
 *
 * 回傳：
 *   { isFalse: boolean, brokeOnDay?: number, halfPrice: number }
 *   - isFalse=true → 該突破進場應剔除（假突破）。
 *   - 若 breakoutIdx 之後資料不足 lookahead 根，回 isFalse=false（無法判定 → 不剔除）。
 *
 * 注意：這是「事後 1~2 根驗證」，回測時等於「突破日進場、但允許用 T+1/T+2 黑 K
 *   收盤確認假突破後改判」。做為對照組可量化假突破剔除對勝率的影響。
 */
export function detectFalseBreakout(
  candles: CandleWithIndicators[],
  breakoutIdx: number,
  lookahead = 2,
): { isFalse: boolean; brokeOnDay: number | null; halfPrice: number } {
  const b = candles[breakoutIdx];
  const halfPrice = (b.high + b.low) / 2;
  for (let i = breakoutIdx + 1; i <= breakoutIdx + lookahead; i++) {
    const k = candles[i];
    if (!k) break;
    const isBlack = k.close < k.open;
    if (isBlack && k.close < halfPrice) {
      return { isFalse: true, brokeOnDay: i - breakoutIdx, halfPrice };
    }
  }
  return { isFalse: false, brokeOnDay: null, halfPrice };
}
