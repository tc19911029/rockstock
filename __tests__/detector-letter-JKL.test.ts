/**
 * 0513 ABCDE B3 — 字母 J / K / L detector 真實 fixture unit tests
 *
 * J: detectABCBreakout — ABC 三段切線突破（書本「ABC 三段攻擊」）
 * K: detectKlineConsolidationBreakout — K 線盤整突破（anchor 黑K 後窄幅整理 → 突破）
 * L: detectBlackKBreakout — 黑K 後攻擊紅K 突破黑K高
 *
 * Ground truth：來自 production scan-TW-long-{J/K/L}-*.json 紀錄。
 */

import { describe, it, expect } from '@jest/globals';
import { detectABCBreakout } from '../lib/analysis/abcBreakoutEntry';
import { detectKlineConsolidationBreakout, findKlineConsolidationRange } from '../lib/analysis/klineConsolidationBreakout';
import { detectBlackKBreakout } from '../lib/analysis/blackKBreakoutEntry';
import { computeIndicators } from '../lib/indicators';
import jFix from './fixtures/candles/8147TWO-J-abc-breakout-2026-04-17.json';
import jFix2 from './fixtures/candles/600487SS-J-abc-breakout-2026-05-29.json';
import kFix from './fixtures/candles/3583-K-kline-consolidation-2026-05-11.json';
import lFix from './fixtures/candles/4927-L-blackK-breakout-2026-05-05.json';

describe('detectABCBreakout (J) — 真實 fixture', () => {
  it(`${jFix.symbol} @ ${jFix.triggerDate} → ABC 突破`, () => {
    const candles = computeIndicators(jFix.candles);
    const result = detectABCBreakout(candles, candles.length - 1);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.isABCBreakout).toBe(true);
    expect(result.bodyPct).toBeGreaterThanOrEqual(jFix.expected.bodyPctMin);
    expect(result.volumeRatio).toBeGreaterThanOrEqual(jFix.expected.volumeRatioMin);
    expect(result.legAHigh).toBeGreaterThanOrEqual(jFix.expected.legAHighMin);
    expect(result.legAHigh).toBeLessThanOrEqual(jFix.expected.legAHighMax);
  });

  // 回歸（2026-05-30）：C 底落在「突破當天才反轉的下跌段」案例。
  // findABCStructures 必須用 findPivots(idx) 含今日，且列舉候選 C 底，否則：
  //   (a) 只看 idx-1 → C 段未收尾、C 底不是 pivot → 腳位退一格成頭頭高被打槍
  //   (b) 貪婪取最近低 → 可能誤抓突破前小回檔（8147 案例）。兩者都要過。
  it(`${jFix2.symbol} @ ${jFix2.triggerDate} → ABC 突破（C 底=最近下跌段）`, () => {
    const candles = computeIndicators(jFix2.candles);
    const result = detectABCBreakout(candles, candles.length - 1);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.isABCBreakout).toBe(true);
    expect(result.bodyPct).toBeGreaterThanOrEqual(jFix2.expected.bodyPctMin);
    expect(result.volumeRatio).toBeGreaterThanOrEqual(jFix2.expected.volumeRatioMin);
    expect(result.legAHigh).toBeGreaterThanOrEqual(jFix2.expected.legAHighMin);
    expect(result.legAHigh).toBeLessThanOrEqual(jFix2.expected.legAHighMax);
  });
});

describe('detectKlineConsolidationBreakout (K) — 真實 fixture', () => {
  it(`${kFix.symbol} @ ${kFix.triggerDate} → K 線盤整突破`, () => {
    const candles = computeIndicators(kFix.candles);
    const result = detectKlineConsolidationBreakout(candles, candles.length - 1);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.isBreakout).toBe(true);
    // 最新講義採「突破前含錨點共三根」，會選到比舊版更近的有效錨點（本 fixture = 812）。
    expect(result.sourceVersion).toBe('latest_handout_3_total');
    expect(result.anchorHigh).toBeCloseTo(812, 0);
    expect(result.rangeWidthPct).toBeLessThanOrEqual(kFix.expected.rangeWidthPctMax);
    expect(result.consolidationDays).toBeGreaterThanOrEqual(kFix.expected.consolidationDaysMin);
  });

  it('最新講義：錨點 + 後續 2 根共三天，第 4 天即可突破', () => {
    const raw = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: 95, high: 96, low: 94, close: 95, volume: 1000,
    }));
    raw[16] = { ...raw[16], open: 100, high: 101, low: 99, close: 100 };
    raw[17] = { ...raw[17], open: 100, high: 101.1, low: 99.4, close: 100.2 };
    raw[18] = { ...raw[18], open: 100.2, high: 101.2, low: 99.6, close: 100.5 };
    raw[19] = { ...raw[19], open: 100.5, high: 104, low: 100.4, close: 103, volume: 1500 };
    const candles = computeIndicators(raw);
    const range = findKlineConsolidationRange(candles, 19);
    expect(range).not.toBeNull();
    expect(range?.anchor.index).toBe(16);
    expect(range?.consolidationDays).toBe(3);
  });
});

describe('detectBlackKBreakout (L) — 真實 fixture', () => {
  it(`${lFix.symbol} @ ${lFix.triggerDate} → 黑K 突破`, () => {
    const candles = computeIndicators(lFix.candles);
    const result = detectBlackKBreakout(candles, candles.length - 1);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.isBlackKBreakout).toBe(true);
    expect(result.blackKHigh).toBeGreaterThanOrEqual(lFix.expected.blackKHighMin);
    expect(result.blackKHigh).toBeLessThanOrEqual(lFix.expected.blackKHighMax);
    expect(result.bodyPct).toBeGreaterThanOrEqual(lFix.expected.bodyPctMin);
  });
});
