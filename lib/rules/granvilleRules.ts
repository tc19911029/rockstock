import { TradingRule, RuleSignal } from '@/types';
import { maDeviation } from './ruleUtils';
import { HIGH_DEVIATION_PCT, BOOK_RECLAIM_LOOKBACK } from '@/lib/analysis/bookThresholds';

// ═══════════════════════════════════════════════════════════════
//  葛蘭碧八大法則 (Granville's 8 Rules)
//  以 MA20 為主要參考均線
// ═══════════════════════════════════════════════════════════════

// ── Helper ──────────────────────────────────────────────────────

/** 判斷 MA20 是否正在上升（近3根均線斜率為正） */
function isMaRising(candles: { ma20?: number }[], index: number): boolean {
  if (index < 3) return false;
  const c = candles[index].ma20;
  const p3 = candles[index - 3].ma20;
  if (c == null || p3 == null) return false;
  return c > p3;
}

/** 判斷 MA20 是否正在下降 */
function isMaFalling(candles: { ma20?: number }[], index: number): boolean {
  if (index < 3) return false;
  const c = candles[index].ma20;
  const p3 = candles[index - 3].ma20;
  if (c == null || p3 == null) return false;
  return c < p3;
}

/** 判斷 MA20 是否持平或轉折 */
function isMaFlattening(candles: { ma20?: number }[], index: number): boolean {
  if (index < 5) return false;
  const c = candles[index].ma20;
  const p5 = candles[index - 5].ma20;
  if (c == null || p5 == null) return false;
  return Math.abs(c - p5) / p5 < 0.005; // 變動率 < 0.5%
}

/**
 * 賣點 7 空單時效（expiry）— 書本 CH3-06：反彈站回月線後 1–3 天內沒跌回 → 訊號失效不能再空。
 * 「超過 3 天還站在月線上（扣抵翻上彎、月線要上揚）就不能再做空；強勢轉強股會連三紅站穩月線。」
 *
 * 判定：在「今日之前」的近窗內，若曾出現「收盤連續 ≥ BOOK_RECLAIM_LOOKBACK(=3) 天站上 MA20」，
 * 表示這波反彈已站穩月線、沒在 3 天內跌回 → 空單訊號過期，granvilleSell7 不再發空訊。
 * 回看窗用 2×BOOK_RECLAIM_LOOKBACK，足以涵蓋「站回後觀察 3 天」這段；用既有常數不新增魔術數。
 */
function isShortSignalExpired(candles: { close: number; ma20?: number }[], index: number): boolean {
  const window = BOOK_RECLAIM_LOOKBACK * 2;
  let consecutiveAbove = 0;
  // 掃今日之前的近窗（不含今日，因今日多半已跌回月線之下才會觸發賣點 7 主邏輯）
  for (let i = index - 1; i >= 0 && i > index - 1 - window; i--) {
    const k = candles[i];
    if (k.ma20 != null && k.close > k.ma20) {
      consecutiveAbove++;
      if (consecutiveAbove >= BOOK_RECLAIM_LOOKBACK) return true;
    } else {
      consecutiveAbove = 0;
    }
  }
  return false;
}

// ── 買入法則 1-4 ───────────────────────────────────────────────

/** 買入法則1: 均線由下降轉為水平或上升，價格由下向上突破均線 */
export const granvilleBuy1: TradingRule = {
  id: 'granville-buy-1',
  name: '葛蘭碧①：突破轉升均線',
  description: 'MA20由下降轉平或上升，價格由下往上突破MA20',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null || prev.ma20 == null) return null;

    const maFlat = isMaFlattening(candles, index) || isMaRising(candles, index);
    const priceCross = prev.close < prev.ma20! && c.close > c.ma20;

    if (!maFlat || !priceCross) return null;

    return {
      type: 'BUY',
      label: '葛蘭碧①買入',
      description: `價格由${prev.close}突破MA20(${c.ma20.toFixed(1)})，均線已轉平/上升`,
      reason: [
        '【葛蘭碧法則①】均線從下降轉為水平或上升時，價格由下向上穿越均線，是最經典的買入訊號。',
        '【原理】均線方向轉變代表趨勢可能反轉，價格突破確認了新趨勢的開始。',
        '【操作建議】搭配成交量放大確認。停損設在均線下方。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 買入法則2: 價格跌破上升中的均線後迅速反彈站回 */
// 2026-07-05 忠實度修：課程 3-6 編號 — ②=回測支撐（回而不破）、③=助漲（跌破後站回）。
// 本規則邏輯是「跌破後站回」＝課程**買點③**；舊標籤誤標②。id 保留不改（避免破壞既有引用）。
export const granvilleBuy2: TradingRule = {
  id: 'granville-buy-2',
  name: '葛蘭碧③：跌破上升均線後站回（助漲）',
  description: '價格跌破上升中的MA20後，迅速站回均線之上（課程買點③）',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;
    if (!isMaRising(candles, index)) return null;

    // 前1-3根有跌破 MA20
    let hadBreakBelow = false;
    for (let i = index - 3; i < index; i++) {
      if (i >= 0 && candles[i].ma20 != null && candles[i].close < candles[i].ma20!) {
        hadBreakBelow = true;
        break;
      }
    }
    if (!hadBreakBelow) return null;

    // 當前站回 MA20 之上
    if (c.close <= c.ma20) return null;

    return {
      type: 'BUY',
      label: '葛蘭碧③買入（助漲）',
      description: `價格跌破上升中MA20後迅速站回(${c.close} > MA20=${c.ma20.toFixed(1)})`,
      reason: [
        '【葛蘭碧法則③（課程 3-6：助漲買點）】價格短暫跌破上升中的均線後迅速回漲站回均線上方。',
        '【原理】上升中的均線有強支撐力，短暫跌破只是洗盤，快速站回代表多方仍然強勢。',
        '【操作建議】這是加碼好時機。若再次跌破且無法站回則停損。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 課程買點②：價格在均線上方回跌但未跌破均線又上漲（回測支撐）
 *  2026-07-05 忠實度修：此邏輯＝課程**買點②**（支撐買點）；舊標籤誤標③。id 保留不改。 */
export const granvilleBuy3: TradingRule = {
  id: 'granville-buy-3',
  name: '葛蘭碧②：均線上方回而不破（支撐）',
  description: '上升趨勢中價格回跌靠近MA20但未跌破，再度上漲（課程買點②）',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null || prev.ma20 == null) return null;
    if (!isMaRising(candles, index)) return null;

    // 近5根都在 MA20 之上
    let allAbove = true;
    for (let i = index - 4; i <= index; i++) {
      if (candles[i].ma20 == null || candles[i].close < candles[i].ma20!) {
        allAbove = false;
        break;
      }
    }
    if (!allAbove) return null;

    // 前幾根有回跌靠近（乖離率 < 2%）
    let hadApproach = false;
    for (let i = index - 3; i < index; i++) {
      const dev = maDeviation(candles[i], 'ma20');
      if (dev != null && dev < 0.02 && dev >= 0) {
        hadApproach = true;
        break;
      }
    }
    if (!hadApproach) return null;

    // 當前反彈（收盤 > 前一日收盤）
    if (c.close <= prev.close) return null;

    // 當前乖離率 > 2%（已拉開）
    const currentDev = maDeviation(c, 'ma20');
    if (currentDev == null || currentDev < 0.02) return null;

    return {
      type: 'BUY',
      label: '葛蘭碧②加碼（支撐）',
      description: `上升趨勢中回測MA20(${c.ma20.toFixed(1)})未破，再度上漲至${c.close}`,
      reason: [
        '【葛蘭碧法則②（課程 3-6：支撐買點）】價格回檔到上升均線附近未跌破，轉而上漲。',
        '【原理】上升趨勢中的回調是健康的，回而不破代表趨勢依然完好。',
        '【操作建議】可加碼做多。停損設在 MA20 下方。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 買入法則4: 價格急跌遠離均線（乖離率過大） */
export const granvilleBuy4: TradingRule = {
  id: 'granville-buy-4',
  name: '葛蘭碧④：急跌遠離均線反彈',
  description: '價格急跌遠離MA20（乖離率超過-15%），短線反彈買入',
  evaluate(candles, index): RuleSignal | null {
    if (index < 4) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null) return null;

    const dev = maDeviation(c, 'ma20');
    if (dev == null || dev >= -HIGH_DEVIATION_PCT) return null; // 乖離率 < -15%（書本 ±15% 對稱）

    // 需有止跌跡象（當日收紅或下影線 > 實體）
    const isRedCandle = c.close > c.open;
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);
    const hasLongLowerShadow = body > 0 && lowerShadow > body;

    if (!isRedCandle && !hasLongLowerShadow) return null;

    // 逐字-24（課程 6-3 買點④原文）：搶反彈買點需「急跌 3 天以上 + 大量後紅K + 突破前一日K線高點」。
    // 對稱賣⑧已於 0ef9307 補「連 3 日爆大量」，買側本輪補齊。葛蘭碧只餵顯示不進 gate，齊三條件才升 BUY。
    const prev3Down = [candles[index - 1], candles[index - 2], candles[index - 3]].every(x => x.close < x.open);
    const avgVol5 = c.avgVol5;
    const bigVolume = avgVol5 != null && avgVol5 > 0 && c.volume >= avgVol5 * 1.3;
    const breakPrevHigh = prev != null && c.close > prev.high;
    const fullSignal = prev3Down && bigVolume && breakPrevHigh;

    return {
      type: fullSignal ? 'BUY' : 'WATCH',
      label: fullSignal ? '葛蘭碧④搶反彈（急跌後大量過前高）' : '葛蘭碧④反彈觀察',
      description: `價格急跌遠離MA20，乖離率=${(dev * 100).toFixed(1)}%，出現止跌跡象${fullSignal ? '＋急跌3日後大量紅K突破前一日高' : '（未齊急跌3日/大量/過前日高三條件，僅觀察）'}`,
      reason: [
        '【葛蘭碧法則④】價格急跌遠離均線，乖離率過大，短線有均值回歸的反彈需求。',
        fullSignal
          ? '【課程 6-3 買④】急跌 3 天以上、大量後紅K突破前一日K線最高點 = 搶反彈的買進訊號。'
          : '【注意】止跌跡象出現但未齊「急跌3日+大量+過前日高」三條件，僅觀察。',
        '【注意】這是短線反彈訊號，不是趨勢反轉。反彈目標通常是回到均線附近。',
        '【操作建議】輕倉試多，嚴設停損。到達均線附近即停利，不要貪心。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 賣出法則 5-8 ───────────────────────────────────────────────

/** 賣出法則5: 均線由上升轉為水平或下降，價格由上向下跌破均線 */
export const granvilleSell5: TradingRule = {
  id: 'granville-sell-5',
  name: '葛蘭碧⑤：跌破轉平均線',
  description: 'MA20由上升轉平或下降，價格由上往下跌破MA20',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null || prev.ma20 == null) return null;

    // 2026-07-05 忠實度修：課程 3-6 賣點⑤原文「均線由上升轉為**下彎**，股價跌破這均線」
    //「一定要月線下彎才能空」— 賣側判準比買側嚴（買點①允許走平，賣點⑤不允許）。
    // 舊版把買側寫法鏡像到賣側（走平也發 SELL）→ 出場提前誤殺。走平降級 WATCH。
    const priceCross = prev.close > prev.ma20! && c.close < c.ma20;
    if (!priceCross) return null;
    const maDown = isMaFalling(candles, index);
    const maFlat = isMaFlattening(candles, index);
    if (!maDown && !maFlat) return null;

    if (!maDown) {
      // 只走平未下彎：課程說還不能確認轉空 → 警示不出場
      return {
        type: 'WATCH',
        label: '葛蘭碧⑤預警（月線走平）',
        description: `價格跌破 MA20(${c.ma20.toFixed(1)}) 但月線僅走平未下彎 — 課程：月線下彎才確認賣點⑤`,
        reason: [
          '【葛蘭碧法則⑤（課程 3-6）】「均線由上升轉為下彎、股價跌破均線」才是賣點⑤。',
          '目前月線只走平還沒下彎，可能只是回測月線支撐（買點③的前奏），先觀察。',
          '【操作建議】月線一下彎且價格仍在其下 → 執行出場；站回月線 → 解除警戒。',
        ].join('\n'),
        ruleId: this.id,
      };
    }

    return {
      type: 'SELL',
      label: '葛蘭碧⑤賣出',
      description: `價格由${prev.close}跌破MA20(${c.ma20.toFixed(1)})，均線已下彎`,
      reason: [
        '【葛蘭碧法則⑤（課程 3-6）】均線由上升轉為下彎，價格由上向下跌破均線，是賣出訊號。',
        '【原理】均線方向轉變 + 價格跌破，雙重確認趨勢反轉。',
        '【操作建議】持有者應停損出場。不宜搶反彈。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 課程賣點⑦：價格突破下降中的均線後迅速回落（假突破）
 *  2026-07-05 忠實度修：此邏輯＝課程**賣點⑦**；舊標籤誤標⑥。id 保留不改。 */
export const granvilleSell6: TradingRule = {
  id: 'granville-sell-6',
  name: '葛蘭碧⑦：假突破下降均線',
  description: '價格突破下降中的MA20後，無法站穩又跌回均線之下（課程賣點⑦）',
  evaluate(candles, index): RuleSignal | null {
    if (index < 3) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;
    if (!isMaFalling(candles, index)) return null;

    let hadBreakAbove = false;
    for (let i = index - 3; i < index; i++) {
      if (i >= 0 && candles[i].ma20 != null && candles[i].close > candles[i].ma20!) {
        hadBreakAbove = true;
        break;
      }
    }
    if (!hadBreakAbove) return null;

    if (c.close >= c.ma20) return null;

    return {
      type: 'SELL',
      label: '葛蘭碧⑦假突破',
      description: `價格曾突破下降中MA20但無法站穩，跌回${c.close} < MA20=${c.ma20.toFixed(1)}`,
      reason: [
        '【葛蘭碧法則⑦】價格突破下降中的均線後迅速回落，是「假突破」的賣出訊號。',
        '【原理】下降中的均線有壓制力，短暫突破只是反彈，無法站穩代表空方仍然主導。',
        '【操作建議】反彈出場的好時機。不要被假突破欺騙而追多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 課程賣點⑥：價格在均線下方反彈但未突破均線又下跌（壓力賣點）
 *  2026-07-05 忠實度修：此邏輯＝課程**賣點⑥**（彈到均線附近遇壓下跌）；舊標籤誤標⑦。id 保留不改。 */
export const granvilleSell7: TradingRule = {
  id: 'granville-sell-7',
  name: '葛蘭碧⑥：均線下方彈不過（壓力）',
  description: '下降趨勢中價格反彈靠近MA20但未突破，再度下跌（課程賣點⑥）',
  evaluate(candles, index): RuleSignal | null {
    if (index < 5) return null;
    const c = candles[index];
    const prev = candles[index - 1];
    if (c.ma20 == null || prev.ma20 == null) return null;
    if (!isMaFalling(candles, index)) return null;

    // 賠少-14：空單時效保護（書本 CH3-06）— 反彈站回月線後 1–3 天內沒跌回則訊號失效。
    // 若近期已連續 ≥3 天站上 MA20（扣抵翻上彎、月線要上揚），不再發空訊（強勢轉強）。
    if (isShortSignalExpired(candles, index)) return null;

    let allBelow = true;
    for (let i = index - 4; i <= index; i++) {
      if (candles[i].ma20 == null || candles[i].close > candles[i].ma20!) {
        allBelow = false;
        break;
      }
    }
    if (!allBelow) return null;

    // 前幾根有反彈靠近（負乖離率 > -2%）
    let hadApproach = false;
    for (let i = index - 3; i < index; i++) {
      const dev = maDeviation(candles[i], 'ma20');
      if (dev != null && dev > -0.02 && dev < 0) {
        hadApproach = true;
        break;
      }
    }
    if (!hadApproach) return null;

    if (c.close >= prev.close) return null;

    return {
      type: 'SELL',
      label: '葛蘭碧⑥加空（壓力）',
      description: `下降趨勢中反彈靠近MA20(${c.ma20.toFixed(1)})未過，再度下跌至${c.close}`,
      reason: [
        '【葛蘭碧法則⑥】價格在下降的均線下方反彈但未突破，再度下跌，是加碼賣出的訊號。',
        '【原理】下降趨勢中的反彈是正常的，反彈不過代表空頭趨勢依然完好。',
        '【操作建議】不要抄底。等價格站回 MA20 之上再考慮做多。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 賣出法則8: 價格急漲遠離均線（乖離率過大） */
export const granvilleSell8: TradingRule = {
  id: 'granville-sell-8',
  name: '葛蘭碧⑧：急漲遠離均線停利',
  description: '價格急漲遠離MA20（乖離率超過+15%），短線停利',
  evaluate(candles, index): RuleSignal | null {
    if (index < 1) return null;
    const c = candles[index];
    if (c.ma20 == null) return null;

    const dev = maDeviation(c, 'ma20');
    if (dev == null || dev <= HIGH_DEVIATION_PCT) return null; // 乖離率 > +15%（書本 ±15% 對稱）

    // 需有滯漲跡象（當日收黑或長上影線）
    const isBlackCandle = c.close < c.open;
    const upperShadow = c.high - Math.max(c.open, c.close);
    const body = Math.abs(c.close - c.open);
    const hasLongUpperShadow = body > 0 && upperShadow > body;

    if (!isBlackCandle && !hasLongUpperShadow) return null;

    // 2026-07-05 忠實度修：課程 3-6 賣點⑧條列「高檔**連 3 日爆大量**」為前提之一 —
    // 舊版只看乖離+滯漲，強勢噴出段每天都可能提前叫減碼。補「近 3 日內至少一日爆量
    //（≥5日均量×1.5）」才發訊。
    let hasRecentBlowoff = false;
    for (let i = Math.max(0, index - 2); i <= index; i++) {
      const k = candles[i];
      if (k.avgVol5 != null && k.avgVol5 > 0 && k.volume >= k.avgVol5 * 1.5) { hasRecentBlowoff = true; break; }
    }
    if (!hasRecentBlowoff) return null;

    return {
      type: 'REDUCE',
      label: '葛蘭碧⑧停利',
      description: `價格急漲遠離MA20，乖離率=+${(dev * 100).toFixed(1)}%，出現滯漲跡象`,
      reason: [
        '【葛蘭碧法則⑧】價格急漲遠離均線，乖離率過大，短線有均值回歸的回調壓力。',
        '【注意】這是短線獲利了結的訊號，不代表趨勢結束。回調目標通常是回到均線附近。',
        '【操作建議】分批停利鎖定獲利。等回調到均線附近再考慮是否重新進場。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

export const GRANVILLE_RULES: TradingRule[] = [
  granvilleBuy1, granvilleBuy2, granvilleBuy3, granvilleBuy4,
  granvilleSell5, granvilleSell6, granvilleSell7, granvilleSell8,
];
