// ═══════════════════════════════════════════════════════════════
// 朱家泓 線上課程 CH5「選股」補強偵測器
//   補齊底部圖形第③種、強勢飆股第二波兩個課程明列但主掃描缺的型態。
//   —— 兩者皆以「觸發規則（顯示層）」身分經 ruleEngine 標示在走圖上，
//      不改動六條件 gate、不進買法字母軌、不碰 scan-parity 合約。
//
//   ⚠️ 誠實 edge 回測結論（scripts/backtest-ch5-new-patterns.ts，2026-07-08，全市場）：
//      兩型態**皆無淨 alpha**、train/test 一致為負 —— 去大盤 beta + 扣成本後
//      底部③ 淨超額 d5 −1.51%/d20 −2.8%（n=3034）、飆股第二波 d5 −1.02%/d20 −1.68%（n=1429）。
//      故**維持顯示層、切勿升級成選股 gate 或排序因子**（raw d20 小正是大盤 beta，非 alpha）。
//      要改判定門檻請先重跑該腳本複驗。
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import { isLongRedCandle, isMaTrendingUp } from './ruleUtils';
import { BOOK_VOL_RATIO_MIN } from '@/lib/analysis/bookThresholds';

/**
 * 底部圖形觀察三：反彈突破月線後橫盤、再突破（CH5-4 第③種）
 *
 * 課程定義（投影片 p05 原文）：
 *   「空頭強力反彈，突破月線壓力，短時間出現股價維持在月線之上整理，開始鎖股，
 *    當月線上揚、大量紅 K 上漲突破橫盤或盤整，開始做短多或長多。」
 *
 * 時序：空頭反彈站上月線 → 黏在月線上橫盤整理 → 月線由下彎轉上揚 →
 *       大量紅 K 突破橫盤高點（多頭確認、進場）
 *
 * 與 O（打底完成）的差別：O 抓「今日剛翻多」，本型態抓「先黏月線整理一段時間」的醞釀，
 * 是五種底部圖形裡主掃描原本唯一沒有的一種。
 */
export const reboundHoldMA20Breakout: TradingRule = {
  id: 'zhu-rebound-hold-ma20-breakout',
  name: '反彈站月線橫盤突破（底部③）',
  description: '空頭反彈站上月線後黏月線橫盤整理，月線由下彎轉上揚，帶量紅K突破橫盤高點',
  evaluate(candles: CandleWithIndicators[], index: number): RuleSignal | null {
    if (index < 40) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;

    // 今日：實體長紅 + 收盤站上月線 + 量 ≥ 1.3×5日均量
    if (!isLongRedCandle(c)) return null;
    if (c.close < c.ma20) return null;
    if (c.avgVol5 != null && c.volume < c.avgVol5 * BOOK_VOL_RATIO_MIN) return null;

    // 月線由下彎（或走平）轉上揚：現在上揚、但約 10 根前尚未上揚
    if (!isMaTrendingUp(candles, index, 'ma20', 3)) return null;
    const earlierIdx = index - 10;
    if (earlierIdx < 5) return null;
    if (isMaTrendingUp(candles, earlierIdx, 'ma20', 3)) return null;

    // 往回抓「連續站在月線上」的橫盤整理區（不含今日）
    const TOL = 0.02;
    let holdStart = index - 1;
    while (
      holdStart > index - 20 && holdStart > 0 &&
      candles[holdStart].ma20 != null &&
      candles[holdStart].close >= (candles[holdStart].ma20 as number) * (1 - TOL)
    ) {
      holdStart--;
    }
    holdStart++;
    const holdLen = index - holdStart; // 整理天數（不含今日）
    if (holdLen < 4 || holdLen > 15) return null; // 課程「短時間整理」

    // 整理前一根必須在月線之下（＝空頭反彈剛突破月線壓力）
    const beforeIdx = holdStart - 1;
    if (beforeIdx < 2) return null;
    const before = candles[beforeIdx];
    if (before.ma20 == null || before.close >= before.ma20) return null;

    // 橫盤區高低點（不含今日）
    let rangeHigh = -Infinity;
    let rangeLow = Infinity;
    for (let i = holdStart; i <= index - 1; i++) {
      rangeHigh = Math.max(rangeHigh, candles[i].high);
      rangeLow = Math.min(rangeLow, candles[i].low);
    }
    if (rangeHigh === -Infinity || rangeLow <= 0) return null;

    // 要是「整理」而非「一路噴出」：整理區振幅 ≤ 18%
    if (rangeHigh / rangeLow - 1 > 0.18) return null;

    // 今日收盤突破橫盤高點
    if (c.close <= rangeHigh) return null;

    return {
      type: 'BUY',
      label: '反彈站月線橫盤突破',
      description: `站月線${holdLen}天整理(${rangeLow.toFixed(1)}~${rangeHigh.toFixed(1)})，月線上揚後帶量突破橫盤高`,
      reason: [
        '【朱家泓 線上課程 CH5-4 底部圖形觀察三】',
        '空頭強力反彈突破月線壓力，短時間股價維持在月線之上整理。',
        '待月線由下彎轉為上揚、大量紅K突破橫盤，多頭確認可做短多或長多。',
        '操作要點：反彈若未站上月線、或站上後又跌破5MA，先離開但別丟掉，它很容易轉多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/**
 * 強勢飆股第二波（CH5-5 強勢飆股主升段選股法）
 *
 * 課程精神：鎖住當下最熱門題材、強勢上漲第一波（連三紅連四紅、四線多排）的飆股高檔，
 *   第一波不追，等回檔不破月線後「回後買上漲」抓第二波（主升段）。主力慣性＝第一波拉強、
 *   第二波往往也強。末段出現超級大量（高檔爆量）要停利。
 *
 * 與既有 `longTermSecondWaveEntry` 的差別：後者限制第一波漲幅 ≤ 50%（溫吞波），
 *   剛好排除強勢飆股；本規則反過來要求「凌厲第一波（≥ 30%）」才鎖第二波。
 *
 * 註：屬鎖股觀察標示（type WATCH），未經誠實 edge 回測前不作為選股 gate。
 */
export const strongSurgeSecondWave: TradingRule = {
  id: 'zhu-strong-surge-second-wave',
  name: '強勢飆股第二波（鎖股候選）',
  description: '凌厲第一波(四線多排+大漲)後回檔不破月線，紅K再起做主升段第二波',
  evaluate(candles: CandleWithIndicators[], index: number): RuleSignal | null {
    if (index < 60) return null;
    const c = candles[index];
    if (c.ma5 == null || c.ma10 == null || c.ma20 == null || c.ma60 == null) return null;

    // 四線多排向上（第一波已走完、均線做好，課程：「不用再想均線有沒有多排」）
    if (!(c.ma5 > c.ma10 && c.ma10 > c.ma20 && c.ma20 > c.ma60)) return null;
    if (!isMaTrendingUp(candles, index, 'ma20', 5)) return null;

    // 凌厲第一波：近 [8,45] 根內的高點，自其前波低點漲幅 ≥ 30%
    const peakWindowStart = Math.max(2, index - 45);
    const peakWindowEnd = index - 8;
    if (peakWindowEnd <= peakWindowStart) return null;
    let firstPeak = -Infinity;
    let firstPeakIdx = -1;
    for (let i = peakWindowStart; i <= peakWindowEnd; i++) {
      if (candles[i].high > firstPeak) { firstPeak = candles[i].high; firstPeakIdx = i; }
    }
    if (firstPeakIdx < 0) return null;
    let priorLow = Infinity;
    for (let i = Math.max(2, firstPeakIdx - 30); i < firstPeakIdx; i++) {
      priorLow = Math.min(priorLow, candles[i].low);
    }
    if (priorLow <= 0 || priorLow === Infinity) return null;
    if (firstPeak / priorLow - 1 < 0.30) return null; // 第一波要凌厲

    // 回檔不破月線：第一波高點之後到昨日，收盤都沒跌破月線
    for (let i = firstPeakIdx + 1; i <= index - 1; i++) {
      const k = candles[i];
      if (k.ma20 != null && k.close < k.ma20) return null;
    }

    // 今日：實體長紅 + 站上 5MA + 量 ≥ 1.3× + 突破近 5 日整理高（第二波起漲）
    if (!isLongRedCandle(c)) return null;
    if (c.close < c.ma5) return null;
    if (c.avgVol5 != null && c.volume < c.avgVol5 * BOOK_VOL_RATIO_MIN) return null;
    const consolidationHigh = Math.max(
      ...candles.slice(Math.max(0, index - 5), index).map(x => x.high),
    );
    if (c.close <= consolidationHigh) return null;

    const wavePct = ((firstPeak / priorLow - 1) * 100).toFixed(0);
    return {
      type: 'WATCH',
      label: '飆股第二波',
      description: `凌厲第一波(+${wavePct}%)後回檔不破月線，今日帶量紅K再起`,
      reason: [
        '【朱家泓 線上課程 CH5-5 強勢飆股主升段選股法】',
        '鎖當下最熱題材、強勢上漲第一波(連三紅連四紅、四線多排)的飆股。',
        '第一波高檔不追，等回檔不破月線後回後買上漲，抓第二波(主升段)。',
        '主力慣性：第一波拉強，第二波往往也強；末段見超級大量(高檔爆量)要停利。',
        '註：此為鎖股觀察標示，未經誠實edge回測前不作為選股 gate。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** CH5 選股補強規則集 */
export const CH5_SELECTION_RULES: TradingRule[] = [
  reboundHoldMA20Breakout,
  strongSurgeSecondWave,
];
