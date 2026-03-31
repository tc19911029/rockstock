import { TradingRule, RuleSignal } from '@/types';

// ═══════════════════════════════════════════════════════════════
//  RSI 進階規則
// ═══════════════════════════════════════════════════════════════

// ── Helper: 找 RSI 局部極值 ─────────────────────────────────────

function findRsiSwings(
  candles: { rsi14?: number }[],
  startIdx: number,
  endIdx: number,
  type: 'high' | 'low',
): { index: number; value: number }[] {
  const swings: { index: number; value: number }[] = [];
  for (let i = startIdx + 1; i < endIdx; i++) {
    const prev = candles[i - 1].rsi14;
    const curr = candles[i].rsi14;
    const next = candles[i + 1]?.rsi14;
    if (prev == null || curr == null || next == null) continue;
    if (type === 'high' && curr > prev && curr > next) {
      swings.push({ index: i, value: curr });
    }
    if (type === 'low' && curr < prev && curr < next) {
      swings.push({ index: i, value: curr });
    }
  }
  return swings;
}

// ── RSI Failure Swing ───────────────────────────────────────────

/** RSI 多頭失敗擺動（W底） */
export const rsiBullishFailureSwing: TradingRule = {
  id: 'rsi-bullish-failure-swing',
  name: 'RSI 多頭 Failure Swing（W底）',
  description: 'RSI在超賣區形成W底：A點<30 → 反彈B → 再跌C不破A → 突破B',
  evaluate(candles, index): RuleSignal | null {
    if (index < 15) return null;
    const c = candles[index];
    if (c.rsi14 == null) return null;

    // 在近20根中尋找 RSI 的低點和高點
    const lookStart = Math.max(0, index - 20);
    const lows = findRsiSwings(candles, lookStart, index, 'low');
    const highs = findRsiSwings(candles, lookStart, index, 'high');

    if (lows.length < 2 || highs.length < 1) return null;

    // W底：第一個低點A < 30，中間高點B，第二個低點C > A，當前突破B
    const a = lows[lows.length - 2];
    const cPoint = lows[lows.length - 1];

    if (a.value >= 30) return null; // A 必須在超賣區
    if (cPoint.value <= a.value) return null; // C 不能比 A 更低

    // 找 A 和 C 之間的高點作為 B
    const bCandidates = highs.filter(h => h.index > a.index && h.index < cPoint.index);
    if (bCandidates.length === 0) return null;
    const b = bCandidates[bCandidates.length - 1];

    // 當前 RSI 突破 B 點
    if (c.rsi14 <= b.value) return null;
    // 確認前一根還沒突破（剛突破）
    const prev = candles[index - 1];
    if (prev.rsi14 != null && prev.rsi14 > b.value) return null;

    return {
      type: 'BUY',
      label: 'RSI Failure Swing↑',
      description: `RSI形成W底：A=${a.value.toFixed(1)} → B=${b.value.toFixed(1)} → C=${cPoint.value.toFixed(1)} → 突破B，當前RSI=${c.rsi14.toFixed(1)}`,
      reason: [
        '【Failure Swing 原理】RSI 的 W 底是比普通超賣反彈更強的訊號。它完全獨立於價格，純粹反映動量的轉變。',
        '【關鍵條件】A 點必須在 30 以下（超賣區），C 點不破 A 點代表賣壓已衰竭，突破 B 點確認動量反轉。',
        '【操作建議】搭配價格突破近期壓力線或均線確認，勝率更高。停損設在 C 點對應的價格下方。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** RSI 空頭失敗擺動（M頂） */
export const rsiBearishFailureSwing: TradingRule = {
  id: 'rsi-bearish-failure-swing',
  name: 'RSI 空頭 Failure Swing（M頂）',
  description: 'RSI在超買區形成M頂：A點>70 → 回落B → 再漲C不破A → 跌破B',
  evaluate(candles, index): RuleSignal | null {
    if (index < 15) return null;
    const c = candles[index];
    if (c.rsi14 == null) return null;

    const lookStart = Math.max(0, index - 20);
    const highs = findRsiSwings(candles, lookStart, index, 'high');
    const lows = findRsiSwings(candles, lookStart, index, 'low');

    if (highs.length < 2 || lows.length < 1) return null;

    const a = highs[highs.length - 2];
    const cPoint = highs[highs.length - 1];

    if (a.value <= 70) return null;
    if (cPoint.value >= a.value) return null;

    const bCandidates = lows.filter(l => l.index > a.index && l.index < cPoint.index);
    if (bCandidates.length === 0) return null;
    const b = bCandidates[bCandidates.length - 1];

    if (c.rsi14 >= b.value) return null;
    const prev = candles[index - 1];
    if (prev.rsi14 != null && prev.rsi14 < b.value) return null;

    return {
      type: 'SELL',
      label: 'RSI Failure Swing↓',
      description: `RSI形成M頂：A=${a.value.toFixed(1)} → B=${b.value.toFixed(1)} → C=${cPoint.value.toFixed(1)} → 跌破B，當前RSI=${c.rsi14.toFixed(1)}`,
      reason: [
        '【Failure Swing 原理】RSI 的 M 頂是比普通超買回調更強的賣出訊號，代表多頭動量已衰竭。',
        '【關鍵條件】A 點在 70 以上（超買區），C 點不破 A 點代表動能已減弱，跌破 B 點確認反轉。',
        '【操作建議】持有者應考慮減倉或停利。搭配價格跌破支撐線或均線確認更可靠。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

// ── RSI 背離 ──────────────────────────────────────────────────

/** RSI 底背離（看漲） */
export const rsiBullishDivergence: TradingRule = {
  id: 'rsi-bullish-divergence',
  name: 'RSI 底背離（價格新低但RSI更高）',
  description: '價格創新低但RSI沒有創新低，下跌動能衰竭',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    if (c.rsi14 == null) return null;

    // 找前一個局部低點
    let prevLowIdx = -1;
    for (let i = index - 3; i >= Math.max(1, index - 15); i--) {
      if (candles[i].close < candles[i - 1].close &&
          candles[i].close < (candles[i + 1]?.close ?? Infinity)) {
        prevLowIdx = i;
        break;
      }
    }
    if (prevLowIdx < 0) return null;
    const prev = candles[prevLowIdx];
    if (prev.rsi14 == null) return null;

    // 價格新低但 RSI 更高
    const priceNewLow = c.close < prev.close;
    const rsiHigher = c.rsi14 > prev.rsi14;

    if (!priceNewLow || !rsiHigher) return null;

    // 需在低檔區域（價格低於 MA20）
    const isLowLevel = c.ma20 != null && c.close < c.ma20 * 0.95;
    if (!isLowLevel) return null;

    return {
      type: 'WATCH',
      label: 'RSI底背離',
      description: `價格新低${c.close} < 前低${prev.close}，但RSI(${c.rsi14.toFixed(1)}) > 前低時RSI(${prev.rsi14.toFixed(1)})`,
      reason: [
        '【底背離原理】價格創新低但 RSI 沒有跟隨，代表下跌的動能正在減弱，空方力量衰竭。',
        '【注意事項】背離是「警告」不是「保證」。需等待價格確認反轉（如突破下降趨勢線、站回均線）再進場。',
        '【加分條件】若同時出現 MACD 底背離或 KD 低檔金叉，則反轉訊號更強。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};

/** RSI 頂背離（看跌） */
export const rsiBearishDivergence: TradingRule = {
  id: 'rsi-bearish-divergence',
  name: 'RSI 頂背離（價格新高但RSI更低）',
  description: '價格創新高但RSI沒有創新高，上漲動能衰竭',
  evaluate(candles, index): RuleSignal | null {
    if (index < 10) return null;
    const c = candles[index];
    if (c.rsi14 == null) return null;

    let prevHighIdx = -1;
    for (let i = index - 3; i >= Math.max(1, index - 15); i--) {
      if (candles[i].close > candles[i - 1].close &&
          candles[i].close > (candles[i + 1]?.close ?? 0)) {
        prevHighIdx = i;
        break;
      }
    }
    if (prevHighIdx < 0) return null;
    const prev = candles[prevHighIdx];
    if (prev.rsi14 == null) return null;

    const priceNewHigh = c.close > prev.close;
    const rsiLower = c.rsi14 < prev.rsi14;

    if (!priceNewHigh || !rsiLower) return null;

    const isHighLevel = c.ma20 != null && c.close > c.ma20 * 1.05;
    if (!isHighLevel) return null;

    return {
      type: 'WATCH',
      label: 'RSI頂背離',
      description: `價格新高${c.close} > 前高${prev.close}，但RSI(${c.rsi14.toFixed(1)}) < 前高時RSI(${prev.rsi14.toFixed(1)})`,
      reason: [
        '【頂背離原理】價格創新高但 RSI 下降，代表上漲動能衰竭。多方力量已不足以推動更強的漲勢。',
        '【停利警訊】持有者應提高警覺，考慮分批停利或設好停損。不宜此時追高。',
        '【加分條件】若同時出現 MACD 頂背離，則反轉訊號更強，應更積極地減倉。',
      ].join('\n'),
      ruleId: this.id,
    };
  },
};
