import type { CandleWithIndicators } from '@/types';
import { evaluateShortSixConditions } from './shortAnalysis';
import { detectShortEntries } from './shortEntries';

/**
 * 正式做空候選的單一入口。
 *
 * S1–S7 是進場觸發；六條件是品質評分。兩者不可再混成「六條件前五項全過」的
 * 全域 gate，否則會錯殺課程明訂量不要求的 S1/S5，以及最新講義量選配的 S7。
 */
export function evaluateShortCourseSetup(candles: CandleWithIndicators[], index: number) {
  const quality = evaluateShortSixConditions(candles, index);
  const entries = detectShortEntries(candles, index);
  return {
    quality,
    entries,
    isEntryReady: entries.length > 0,
  };
}
