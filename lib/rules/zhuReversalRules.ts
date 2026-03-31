// ═══════════════════════════════════════════════════════════════
// 朱家泓《抓住線圖 股民變股神》
// 戰法8：底部/頭部反轉型態偵測 + 盤整突破方向預判
// ═══════════════════════════════════════════════════════════════

import { TradingRule, RuleSignal, CandleWithIndicators } from '@/types';
import { recentHigh, recentLow } from '@/lib/indicators';
import { isLongRedCandle, isLongBlackCandle } from './ruleUtils';

// ── 底部3種反轉型態 ──────────────────────────────────────────────────────────

/**
 * 找 lookback 期間內的 swing lows（局部低點）
 */
function findSwingLows(candles: CandleWithIndicators[], index: number, lookback: number): { idx: number; low: number }[] {
  const result: { idx: number; low: number }[] = [];
  const start = Math.max(2, index - lookback);
  for (let i = start; i <= index - 2; i++) {
    if (candles[i].low <= candles[i - 1].low && candles[i].low <= candles[i + 1].low) {
      result.push({ idx: i, low: candles[i].low });
    }
  }
  return result;
}

/**
 * 找 lookback 期間內的 swing highs（局部高點）
 */
function findSwingHighs(candles: CandleWithIndicators[], index: number, lookback: number): { idx: number; high: number }[] {
  const result: { idx: number; high: number }[] = [];
  const start = Math.max(2, index - lookback);
  for (let i = start; i <= index - 2; i++) {
    if (candles[i].high >= candles[i - 1].high && candles[i].high >= candles[i + 1].high) {
      result.push({ idx: i, high: candles[i].high });
    }
  }
  return result;
}

/** 平底穿頭：2~3個相近低點 + 帶量突破上頸線 */
export const flatBottomBreakout: TradingRule = {
  id: 'zhu-flat-bottom-breakout',
  name: '平底穿頭（底部反轉）',
  description: '低檔出現2~3個相近價位的低點，往上突破前面高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const swingLows = findSwingLows(candles, index, 40);
    if (swingLows.length < 2) return null;

    const l1 = swingLows[swingLows.length - 2];
    const l2 = swingLows[swingLows.length - 1];

    // 兩個低點相近（差距 < 2%）
    const diff = Math.abs(l1.low - l2.low) / l1.low;
    if (diff > 0.02) return null;

    // 找兩低之間的高點作為頸線
    let neckline = -Infinity;
    for (let i = l1.idx; i <= l2.idx; i++) {
      neckline = Math.max(neckline, candles[i].high);
    }
    if (neckline === -Infinity) return null;

    // 今日帶量突破頸線
    if (c.close <= neckline) return null;
    if (!isLongRedCandle(c)) return null;
    const avgVol = c.avgVol5;
    if (avgVol != null && c.volume < avgVol * 1.2) return null;

    return {
      type: 'BUY',
      label: '平底穿頭',
      description: `雙底(${l1.low.toFixed(2)}/${l2.low.toFixed(2)}) 帶量突破頸線 ${neckline.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住線圖》第2章 底部反轉型態①】',
        '平底穿頭：股價跌到低檔，出現2個或3個價位相近的低價後，往上突破前面的高點。',
        '是打底完成的訊號，可以鎖住該股票，把握做多買進的機會。',
        '如果是在週線圖或月線圖出現，極可能是大波段起漲的開始。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 高底穿頭：底底高 + 帶量突破前高 */
export const higherBottomBreakout: TradingRule = {
  id: 'zhu-higher-bottom-breakout',
  name: '高底穿頭（底部反轉）',
  description: '低檔出現底底高，且不破前面低價，往上突破前面高點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const swingLows = findSwingLows(candles, index, 40);
    if (swingLows.length < 2) return null;

    const l1 = swingLows[swingLows.length - 2];
    const l2 = swingLows[swingLows.length - 1];

    // 底底高：第二個低點高於第一個
    if (l2.low <= l1.low) return null;

    // 找區間高點作為頸線
    let neckline = -Infinity;
    for (let i = l1.idx; i <= l2.idx; i++) {
      neckline = Math.max(neckline, candles[i].high);
    }
    if (neckline === -Infinity) return null;

    // 帶量突破頸線
    if (c.close <= neckline) return null;
    if (!isLongRedCandle(c)) return null;
    const avgVol = c.avgVol5;
    if (avgVol != null && c.volume < avgVol * 1.2) return null;

    return {
      type: 'BUY',
      label: '高底穿頭',
      description: `底底高(${l1.low.toFixed(2)}→${l2.low.toFixed(2)}) 突破頸線 ${neckline.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住線圖》第2章 底部反轉型態②】',
        '高底穿頭：股價跌到低檔，出現「底底高」且不破前面的低價，再往上突破前面的高點。',
        '是打底完成的訊號，可以鎖住該股票，把握做多買進的機會。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 破底穿頭：假跌破 + 反轉過前高（最強底部型態） */
export const falseBreakdownBreakout: TradingRule = {
  id: 'zhu-false-breakdown-breakout',
  name: '破底穿頭（假跌破反轉）',
  description: '股價繼續破底後出現向上反彈過前面高點，假跌破真穿頭',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const swingLows = findSwingLows(candles, index, 40);
    if (swingLows.length < 2) return null;

    const l1 = swingLows[swingLows.length - 2];
    const l2 = swingLows[swingLows.length - 1];

    // 破底：第二個低點低於第一個（假跌破）
    if (l2.low >= l1.low) return null;

    // 但已經反轉向上（目前收盤高於兩低之間的高點）
    let neckline = -Infinity;
    for (let i = l1.idx; i <= Math.min(l2.idx + 5, index); i++) {
      if (i < candles.length) neckline = Math.max(neckline, candles[i].high);
    }
    if (neckline === -Infinity) return null;

    if (c.close <= neckline) return null;
    if (!isLongRedCandle(c)) return null;

    return {
      type: 'BUY',
      label: '破底穿頭(最強)',
      description: `假跌破(${l2.low.toFixed(2)}<${l1.low.toFixed(2)}) 真穿頭過 ${neckline.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住線圖》第2章 底部反轉型態③】',
        '破底穿頭：股價跌到低檔，繼續破底後出現向上反彈過前面高點的走勢。',
        '這種假跌破真穿頭的底部型態，由空頭反轉成多頭後走勢會比較強。',
        '我們無法買到破底的低點，但是可以鎖住穿頭後拉回的「底底高」買進位置。',
        '【最強型態】三種底部反轉中最強的一種。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 頭部3種反轉型態 ──────────────────────────────────────────────────────────

/** 平頭破底：2~3個相近高點 + 跌破下頸線 */
export const flatTopBreakdown: TradingRule = {
  id: 'zhu-flat-top-breakdown',
  name: '平頭破底（頭部反轉）',
  description: '高檔出現2~3個相近價位的高點，往下跌破前面底點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const swingHighs = findSwingHighs(candles, index, 40);
    if (swingHighs.length < 2) return null;

    const h1 = swingHighs[swingHighs.length - 2];
    const h2 = swingHighs[swingHighs.length - 1];

    // 兩個高點相近（差距 < 2%）
    const diff = Math.abs(h1.high - h2.high) / h1.high;
    if (diff > 0.02) return null;

    // 找兩高之間的低點作為下頸線
    let neckline = Infinity;
    for (let i = h1.idx; i <= h2.idx; i++) {
      neckline = Math.min(neckline, candles[i].low);
    }
    if (neckline === Infinity) return null;

    // 今日跌破下頸線
    if (c.close >= neckline) return null;
    if (!isLongBlackCandle(c)) return null;

    return {
      type: 'SELL',
      label: '平頭破底',
      description: `雙頭(${h1.high.toFixed(2)}/${h2.high.toFixed(2)}) 跌破頸線 ${neckline.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住線圖》第2章 頭部反轉型態①】',
        '平頭破底：股價漲到高檔，出現2個或3個價位相近的頭部後，往下跌破前面的底點。',
        '是頭部完成的訊號，多頭要出場，做空可以鎖住該股票，等待放空的機會。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 低頭破底：頭頭低 + 跌破前低 */
export const lowerTopBreakdown: TradingRule = {
  id: 'zhu-lower-top-breakdown',
  name: '低頭破底（頭部反轉）',
  description: '高檔出現頭不過前面高點，再往下跌破前面低點',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const swingHighs = findSwingHighs(candles, index, 40);
    if (swingHighs.length < 2) return null;

    const h1 = swingHighs[swingHighs.length - 2];
    const h2 = swingHighs[swingHighs.length - 1];

    // 頭頭低
    if (h2.high >= h1.high) return null;

    // 找區間低點作為下頸線
    let neckline = Infinity;
    for (let i = h1.idx; i <= h2.idx; i++) {
      neckline = Math.min(neckline, candles[i].low);
    }
    if (neckline === Infinity) return null;

    // 跌破下頸線
    if (c.close >= neckline) return null;
    if (!isLongBlackCandle(c)) return null;

    return {
      type: 'SELL',
      label: '低頭破底',
      description: `頭頭低(${h1.high.toFixed(2)}→${h2.high.toFixed(2)}) 跌破頸線 ${neckline.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住線圖》第2章 頭部反轉型態②】',
        '低頭破底：股價漲到高檔，出現頭不過前面的高點，再往下跌破前面的低點。',
        '是頭部完成的訊號，多頭要出場，做空可以鎖住該股票。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** 穿頭破底：假突破 + 反轉破前低（最弱頭部型態） */
export const falseBreakoutBreakdown: TradingRule = {
  id: 'zhu-false-breakout-breakdown',
  name: '穿頭破底（假突破反轉）',
  description: '股價繼續過前高後向下回檔跌破前面低點，假突破真破底',
  evaluate(candles, index): RuleSignal | null {
    if (index < 30) return null;
    const c = candles[index];

    const swingHighs = findSwingHighs(candles, index, 40);
    if (swingHighs.length < 2) return null;

    const h1 = swingHighs[swingHighs.length - 2];
    const h2 = swingHighs[swingHighs.length - 1];

    // 穿頭：第二個高點高於第一個（假突破）
    if (h2.high <= h1.high) return null;

    // 找區間低點
    let neckline = Infinity;
    for (let i = h1.idx; i <= Math.min(h2.idx + 5, index); i++) {
      if (i < candles.length) neckline = Math.min(neckline, candles[i].low);
    }
    if (neckline === Infinity) return null;

    // 跌破下頸線
    if (c.close >= neckline) return null;
    if (!isLongBlackCandle(c)) return null;

    return {
      type: 'SELL',
      label: '穿頭破底(最弱)',
      description: `假突破(${h2.high.toFixed(2)}>${h1.high.toFixed(2)}) 真破底破 ${neckline.toFixed(2)}`,
      reason: [
        '【朱家泓《抓住線圖》第2章 頭部反轉型態③】',
        '穿頭破底：股價漲到高檔，出現繼續過前高後向下回檔跌破前面低點的走勢。',
        '這種假突破真破底的頭部型態，反轉成空頭走勢會比較強。',
        '【最弱型態】三種頭部反轉中最弱（空頭最強）的一種。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── 盤整突破方向預判 ──────────────────────────────────────────────────────────

/** 盤整突破方向預判：價在1/2線上方偏多、下方偏空 */
export const consolidationBreakoutDirection: TradingRule = {
  id: 'zhu-consolidation-breakout-direction',
  name: '盤整突破方向預判（1/2線）',
  description: '盤整時觀察股價在盤整區1/2線的位置，預判突破方向',
  evaluate(candles, index): RuleSignal | null {
    if (index < 20) return null;
    const c = candles[index];

    // 偵測是否在盤整：BB帶寬窄
    if (c.bbBandwidth == null) return null;
    const recentBW: number[] = [];
    for (let i = Math.max(0, index - 20); i < index; i++) {
      if (candles[i].bbBandwidth != null) recentBW.push(candles[i].bbBandwidth!);
    }
    if (recentBW.length < 10) return null;
    const avgBW = recentBW.reduce((a, b) => a + b, 0) / recentBW.length;
    if (c.bbBandwidth > avgBW) return null;

    // 計算盤整區間的 1/2 線
    const rangeHigh = recentHigh(candles, index, 20);
    const rangeLow = recentLow(candles, index, 20);
    if (rangeHigh === -Infinity || rangeLow === Infinity) return null;
    const halfLine = (rangeHigh + rangeLow) / 2;

    // 計算近5日有幾日在1/2線上方
    let aboveCount = 0;
    for (let i = Math.max(0, index - 4); i <= index; i++) {
      if (candles[i].close > halfLine) aboveCount++;
    }

    const isAbove = aboveCount >= 4;
    const isBelow = aboveCount <= 1;
    if (!isAbove && !isBelow) return null;

    return {
      type: 'WATCH',
      label: isAbove ? '盤整偏多' : '盤整偏空',
      description: `盤整區(${rangeLow.toFixed(2)}~${rangeHigh.toFixed(2)})，1/2線${halfLine.toFixed(2)}，近5日${aboveCount}日在上方`,
      reason: [
        '【朱家泓《抓住線圖》第3章 盤整突破方向預判】',
        '觀察盤整後面走勢：如果往盤整區域的1/2位置上面發展，股價出量容易向上突破。',
        '如果往盤整區域的1/2位置下面發展，股價不必要大量，就可以向下跌破。',
        isAbove
          ? '【偏多】近5日大多在1/2線上方，主力氣勢強，準備往上突破機率高。'
          : '【偏空】近5日大多在1/2線下方，向下跌破的機率較高。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};
