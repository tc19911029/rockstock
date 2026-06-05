/**
 * 單元測試 — K 棒三級制 helpers（朱家泓課程 CH2-4/2-5：小棒 / 中棒 / 最大棒）
 *
 * Batch 1 (1.2)：純新增 helper，平行於既有 isLongRed/isMedLong（≥2%）與
 * isSmallCandle（<1.5%）。本測試鎖定三級門檻（中棒 3.5%–6.5%、最大棒 ≥6.5%）
 * 與「最大棒不同時為中棒」「新舊 helper 並存不互斥」兩個邊界。
 */

import {
  isMaxBullishCandle,
  isMaxBearishCandle,
  isMediumRed,
  isMediumBlack,
  isLongRedCandle,
  isSmallCandle,
} from '@/lib/rules/ruleUtils';
import type { CandleWithIndicators } from '@/types';

function candle(open: number, close: number): CandleWithIndicators {
  return {
    date: '2026-01-01',
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1000,
  };
}

describe('K 棒三級制（CH2-4/2-5）', () => {
  test('最大棒紅K：實體 ≥ 6.5%', () => {
    expect(isMaxBullishCandle(candle(100, 107))).toBe(true); // +7%
    expect(isMaxBullishCandle(candle(100, 106))).toBe(false); // +6% < 6.5%
    expect(isMaxBullishCandle(candle(100, 93))).toBe(false); // 黑K
  });

  test('最大棒黑K：實體 ≥ 6.5%', () => {
    expect(isMaxBearishCandle(candle(100, 93))).toBe(true); // -7%
    expect(isMaxBearishCandle(candle(100, 95))).toBe(false); // -5%
    expect(isMaxBearishCandle(candle(100, 107))).toBe(false); // 紅K
  });

  test('中紅棒：3.5% ≤ 實體 < 6.5%', () => {
    expect(isMediumRed(candle(100, 104))).toBe(true); // +4%
    expect(isMediumRed(candle(100, 103))).toBe(false); // +3% < 3.5%
    expect(isMediumRed(candle(100, 107))).toBe(false); // +7% ≥ 6.5%（屬最大棒）
    expect(isMediumRed(candle(100, 96))).toBe(false); // 黑K
  });

  test('中黑棒：3.5% ≤ 實體 < 6.5%', () => {
    expect(isMediumBlack(candle(100, 96))).toBe(true); // -4%
    expect(isMediumBlack(candle(100, 93))).toBe(false); // -7% ≥ 6.5%（屬最大棒）
    expect(isMediumBlack(candle(100, 104))).toBe(false); // 紅K
  });

  test('三級不重疊：最大棒不同時被判為中棒', () => {
    const big = candle(100, 107);
    expect(isMaxBullishCandle(big)).toBe(true);
    expect(isMediumRed(big)).toBe(false);
  });

  test('與既有 helper 並存（不互斥）：4% 紅K 同時是 isLongRed 與中棒、非小棒', () => {
    const med = candle(100, 104);
    expect(isLongRedCandle(med)).toBe(true); // ≥2%
    expect(isMediumRed(med)).toBe(true); // 3.5–6.5%
    expect(isSmallCandle(med)).toBe(false); // <1.5%
  });
});
