/**
 * 三條均線戰法 MA3+10+24 完整版（Phase 3.3）
 *
 * 書本來源（rule #5 對齊）：
 *   - 朱家泓網路課程「三條均線戰法 MA3+10+24」
 *   - 寶典 Part 11-3 三均線運用
 *
 * 與既有 Q 字母關係：
 *   - 既有 Q 是「MA20 乖離率」實作（保留為 Q_legacy）
 *   - 本模組提供「正統三均線戰法」邏輯（StrategyConfig.enhancedSelection.threeMA='full' 才啟用）
 *
 * 進場規則（同時滿足）：
 *   1. MA3 上穿 MA10（前一根 MA3 ≤ MA10，當根 MA3 > MA10）
 *   2. MA10 > MA24（中期多頭結構成立）
 *   3. 三均同向上揚（MA3 / MA10 / MA24 斜率為正，前一根比再前一根高）
 *
 * 出場規則：
 *   - MA3 < MA10（黃金死叉）：**部分減倉** signal
 *   - MA10 < MA24（中期空頭）：**全出** signal
 *
 * 不變式：
 *   - 純函式
 *   - 不讀檔
 *   - candles 必須按 date asc 排序
 *   - 至少 25 根 K 線才能算 MA24
 */

export const THREE_MA_BOOK_REF = {
  book: '朱家泓網路課程',
  part: '三條均線戰法 MA3+10+24',
  topic: '三均線多頭排列 + 黃金交叉進場、死叉出場',
  rule: 'Q_full_replaces_Q_legacy_when_enabled',
} as const;

export interface ThreeMACandle {
  date: string;
  close: number;
}

export interface ThreeMASignal {
  entrySignal: boolean;
  exitPartialSignal: boolean;
  exitFullSignal: boolean;
  ma3: number | null;
  ma10: number | null;
  ma24: number | null;
  /** MA3-MA10 上一根狀態（用於判斷「上穿」）*/
  ma3PrevAboveMa10: boolean | null;
  /** 三均線斜率（正=向上、負=向下、null=樣本不足）*/
  ma3Slope: number | null;
  ma10Slope: number | null;
  ma24Slope: number | null;
  reason: string;
}

const MA_SHORT = 3;
const MA_MID = 10;
const MA_LONG = 24;
const MIN_CANDLES = MA_LONG + 1; // 多 1 根算斜率

function sma(closes: readonly number[], period: number, endIdx: number): number | null {
  if (endIdx + 1 < period) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += closes[i];
  return sum / period;
}

/** 純函式：給 candles（按 date asc）算當前 3MA 戰法訊號 */
export function detectThreeMA(candles: ReadonlyArray<ThreeMACandle>): ThreeMASignal {
  const closes = candles.map(c => c.close);
  const n = closes.length;
  if (n < MIN_CANDLES) {
    return {
      entrySignal: false,
      exitPartialSignal: false,
      exitFullSignal: false,
      ma3: null, ma10: null, ma24: null,
      ma3PrevAboveMa10: null,
      ma3Slope: null, ma10Slope: null, ma24Slope: null,
      reason: `K 線不足 ${MIN_CANDLES} 根（got ${n}）`,
    };
  }

  const lastIdx = n - 1;
  const ma3 = sma(closes, MA_SHORT, lastIdx);
  const ma10 = sma(closes, MA_MID, lastIdx);
  const ma24 = sma(closes, MA_LONG, lastIdx);
  const ma3Prev = sma(closes, MA_SHORT, lastIdx - 1);
  const ma10Prev = sma(closes, MA_MID, lastIdx - 1);
  const ma24Prev = sma(closes, MA_LONG, lastIdx - 1);

  if (ma3 == null || ma10 == null || ma24 == null
      || ma3Prev == null || ma10Prev == null || ma24Prev == null) {
    return {
      entrySignal: false, exitPartialSignal: false, exitFullSignal: false,
      ma3, ma10, ma24,
      ma3PrevAboveMa10: null,
      ma3Slope: null, ma10Slope: null, ma24Slope: null,
      reason: 'MA 計算失敗',
    };
  }

  const ma3Slope = ma3 - ma3Prev;
  const ma10Slope = ma10 - ma10Prev;
  const ma24Slope = ma24 - ma24Prev;
  const ma3PrevAboveMa10 = ma3Prev > ma10Prev;
  const ma3NowAboveMa10 = ma3 > ma10;
  const ma3CrossUpMa10 = !ma3PrevAboveMa10 && ma3NowAboveMa10;
  const ma3CrossDownMa10 = ma3PrevAboveMa10 && !ma3NowAboveMa10;
  const ma10AboveMa24 = ma10 > ma24;
  const ma10PrevAboveMa24 = ma10Prev > ma24Prev;
  const ma10CrossDownMa24 = ma10PrevAboveMa24 && !ma10AboveMa24;

  // 進場：MA3 上穿 MA10 + MA10 > MA24 + 三均斜率為正
  const allSlopesUp = ma3Slope > 0 && ma10Slope > 0 && ma24Slope > 0;
  const entrySignal = ma3CrossUpMa10 && ma10AboveMa24 && allSlopesUp;

  // 出場：
  // 部分減倉 = MA3 跌破 MA10（黃金死叉）
  // 全出 = MA10 跌破 MA24
  const exitPartialSignal = ma3CrossDownMa10;
  const exitFullSignal = ma10CrossDownMa24;

  let reason = '';
  if (entrySignal) {
    reason = `進場：MA3 上穿 MA10（${ma3.toFixed(2)} > ${ma10.toFixed(2)}）+ MA10 > MA24（${ma10.toFixed(2)} > ${ma24.toFixed(2)}）+ 三均斜率正`;
  } else if (exitFullSignal) {
    reason = `全出：MA10 跌破 MA24（${ma10.toFixed(2)} < ${ma24.toFixed(2)}）`;
  } else if (exitPartialSignal) {
    reason = `部分減倉：MA3 跌破 MA10（${ma3.toFixed(2)} < ${ma10.toFixed(2)}）`;
  } else if (!ma10AboveMa24) {
    reason = `空頭結構：MA10 ${ma10.toFixed(2)} ≤ MA24 ${ma24.toFixed(2)}`;
  } else if (!allSlopesUp) {
    reason = `三均線非全部向上：ma3Slope=${ma3Slope.toFixed(2)} ma10Slope=${ma10Slope.toFixed(2)} ma24Slope=${ma24Slope.toFixed(2)}`;
  } else if (!ma3CrossUpMa10) {
    reason = ma3NowAboveMa10
      ? `MA3 已在 MA10 上方（無新進場訊號，續抱）`
      : `MA3 在 MA10 下方，等待上穿`;
  } else {
    reason = '無訊號';
  }

  return {
    entrySignal,
    exitPartialSignal,
    exitFullSignal,
    ma3, ma10, ma24,
    ma3PrevAboveMa10,
    ma3Slope, ma10Slope, ma24Slope,
    reason,
  };
}

export const THREE_MA_CONST = {
  MA_SHORT, MA_MID, MA_LONG, MIN_CANDLES,
} as const;
