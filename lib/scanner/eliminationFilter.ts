/**
 * eliminationFilter.ts — 朱家泓《活用技術分析寶典》淘汰法選股
 *
 * 書中 Part 10 (P659-668) 定義了 11 種要避開的股票狀況。
 * 此模組在 scanner 輸出前加一層負面篩選，
 * 排除不符合朱老師方法論的高風險股票。
 */

import { CandleWithIndicators } from '@/types';

export interface EliminationResult {
  eliminated: boolean;
  reasons: string[];
  /** 扣分（0-20），不淘汰時也可能有扣分 */
  penalty: number;
}

/**
 * 1. 沒走出底部的股票：趨勢未完成，均線未多排
 */
function rule01_notOutOfBottom(candles: CandleWithIndicators[], idx: number): string | null {
  const c = candles[idx];
  if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;
  // 均線空排 + 股價在月線下
  if (c.ma5 < c.ma10 && c.ma10 < c.ma20 && c.close < c.ma20) {
    return '淘汰1: 尚未走出底部（均線空排、股價在月線下）';
  }
  return null;
}

/**
 * 2. 重壓不過跌破MA5：趨勢完成但遇重壓不過
 */
function rule02_resistanceBlockBreakMA5(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 20) return null;
  const c = candles[idx];
  if (c.ma5 == null || c.close >= c.ma5) return null;
  // 過去20天有明顯高點壓力
  const prev20High = Math.max(...candles.slice(idx - 20, idx).map(x => x.high));
  if (prev20High > 0 && c.high >= prev20High * 0.98 && c.close < c.ma5) {
    return '淘汰2: 遇重壓不過且跌破MA5';
  }
  return null;
}

/**
 * 3. 上漲一波後趨勢不明確
 */
function rule03_unclearTrend(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 20) return null;
  const c = candles[idx];
  // 有壓有撐的區間震盪：最近20天高低差 < 10%
  const lookback = candles.slice(idx - 20, idx + 1);
  const highs = lookback.map(x => x.high);
  const lows = lookback.map(x => x.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  if (rangeLow <= 0) return null;
  const spread = (rangeHigh - rangeLow) / rangeLow;
  // 均線雜亂（非多排也非空排）
  if (c.ma5 != null && c.ma10 != null && c.ma20 != null) {
    const isBull = c.ma5 > c.ma10 && c.ma10 > c.ma20;
    const isBear = c.ma5 < c.ma10 && c.ma10 < c.ma20;
    if (!isBull && !isBear && spread < 0.10) {
      return '淘汰3: 上漲一波後趨勢不明確（均線雜亂、區間震盪）';
    }
  }
  return null;
}

/**
 * 4. 沒有量能：上漲行進中成交量明顯縮小
 */
function rule04_noVolume(candles: CandleWithIndicators[], idx: number): string | null {
  const c = candles[idx];
  if (c.avgVol5 == null || c.avgVol5 <= 0) return null;
  // 量比 < 0.5（量萎縮到均量一半以下）
  if (c.volume < c.avgVol5 * 0.5) {
    return '淘汰4: 成交量嚴重萎縮（量比<0.5）';
  }
  return null;
}

/**
 * 5. 大幅上漲過高：股價已漲超過1倍
 */
function rule05_overExtended(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 60) return null;
  const c = candles[idx];
  // 過去60天最低價
  const low60 = Math.min(...candles.slice(Math.max(0, idx - 60), idx).map(x => x.low));
  if (low60 > 0 && c.close > low60 * 2) {
    return '淘汰5: 大幅上漲過高（漲幅超過1倍）';
  }
  return null;
}

/**
 * 6. 遇壓力大量長黑：壓力線附近多次出現大量長黑K
 */
function rule06_resistanceLongBlack(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 10) return null;
  // 過去10天在高檔出現2次以上大量長黑
  const recent = candles.slice(idx - 10, idx + 1);
  const bigBlacks = recent.filter(c =>
    c.close < c.open &&
    Math.abs(c.close - c.open) / c.open >= 0.02 &&
    c.avgVol5 != null && c.avgVol5 > 0 && c.volume >= c.avgVol5 * 1.5
  );
  if (bigBlacks.length >= 2) {
    return '淘汰6: 近10天出現2次以上大量長黑K';
  }
  return null;
}

/**
 * 7. MACD或KD指標背離
 */
function rule07_indicatorDivergence(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 10) return null;
  const c = candles[idx];
  const prev5 = candles[idx - 5];
  // 價格創新高但MACD OSC走低（頭頭低）
  if (c.macdOSC != null && prev5?.macdOSC != null) {
    if (c.high > prev5.high && c.macdOSC < prev5.macdOSC) {
      return '淘汰7: MACD指標背離（價創新高但OSC走低）';
    }
  }
  // KD 背離
  if (c.kdK != null && prev5?.kdK != null) {
    if (c.high > prev5.high && c.kdK < prev5.kdK) {
      return '淘汰7: KD指標背離（價創新高但K值走低）';
    }
  }
  return null;
}

/**
 * 9. 頻頻爆大量股價不漲
 */
function rule09_highVolNoRise(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 5) return null;
  const recent = candles.slice(idx - 5, idx + 1);
  const highVolDays = recent.filter(c =>
    c.avgVol5 != null && c.avgVol5 > 0 && c.volume >= c.avgVol5 * 2
  );
  if (highVolDays.length >= 3) {
    // 有3天以上爆大量
    const priceChange = (recent[recent.length - 1].close - recent[0].close) / recent[0].close;
    if (Math.abs(priceChange) < 0.03) {
      return '淘汰9: 頻頻爆大量但股價不漲（主力出貨）';
    }
  }
  return null;
}

/**
 * 10. 連3天長黑下跌
 */
function rule10_threeBlacks(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 3) return null;
  const d1 = candles[idx - 2], d2 = candles[idx - 1], d3 = candles[idx];
  const isLB = (c: CandleWithIndicators) => c.close < c.open && Math.abs(c.close - c.open) / c.open >= 0.015;
  if (isLB(d1) && isLB(d2) && isLB(d3)) {
    return '淘汰10: 連續3天長黑K下跌';
  }
  return null;
}

// ── Main Evaluator ──────────────────────────────────────────────────────────────

/**
 * 8. 三大法人連續賣超：下跌時出現爆大量長黑K或連3黑大量賣壓
 * 注：rockstock 沒有法人買賣超資料，用「連續大量下跌」作為代理指標
 */
function rule08_institutionalSelling(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 5) return null;
  // 近5日中有3天以上是大量黑K（量比>1.3 且收黑）
  const recent5 = candles.slice(idx - 4, idx + 1);
  const bigVolBlacks = recent5.filter(c =>
    c.close < c.open &&
    c.avgVol5 != null && c.avgVol5 > 0 && c.volume >= c.avgVol5 * 1.3
  );
  if (bigVolBlacks.length >= 3) {
    return '淘汰8: 連續大量黑K賣壓（疑似法人連續賣超）';
  }
  return null;
}

/**
 * 10. 看不懂的股票要避開：盤整中趨勢未明，出現明確訊號才順勢操作
 * 補充判斷：長期盤整（30天以上）+ 均線糾結 + 量能萎縮
 */
function rule10b_longConsolidation(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 30) return null;
  const c = candles[idx];
  // 30天高低差 < 8%
  const lookback = candles.slice(idx - 30, idx + 1);
  const rangeHigh = Math.max(...lookback.map(x => x.high));
  const rangeLow = Math.min(...lookback.map(x => x.low));
  if (rangeLow <= 0) return null;
  const spread = (rangeHigh - rangeLow) / rangeLow;
  if (spread >= 0.08) return null;
  // 均線糾結：MA5/MA10/MA20 差距 < 2%
  if (c.ma5 != null && c.ma10 != null && c.ma20 != null) {
    const maMax = Math.max(c.ma5, c.ma10, c.ma20);
    const maMin = Math.min(c.ma5, c.ma10, c.ma20);
    if (maMin > 0 && (maMax - maMin) / maMin < 0.02) {
      return '淘汰10: 長期盤整趨勢不明（30天振幅<8%、均線糾結），看不懂勿進場';
    }
  }
  return null;
}

/**
 * 11. 有基本面沒技術面的股票要避開
 * 技術面差的判斷：股價在MA20之下 + MA20下彎 + 均線空排
 * （基本面好壞由用戶自行判斷，此處只偵測技術面差的股票）
 */
function rule11_noTechnical(candles: CandleWithIndicators[], idx: number): string | null {
  if (idx < 20) return null;
  const c = candles[idx];
  if (c.ma5 == null || c.ma10 == null || c.ma20 == null) return null;
  // 收紅K（看似有機會）但技術面全面轉壞
  if (c.close <= c.open) return null; // 只在收紅時警告（散戶覺得跌深可買）
  const belowMa20 = c.close < c.ma20;
  const prevMa20_5 = idx > 5 ? candles[idx - 5]?.ma20 : null;
  const ma20Declining = prevMa20_5 != null && c.ma20! < prevMa20_5;
  const bearishAlign = c.ma5 < c.ma10 && c.ma10 < c.ma20;
  if (belowMa20 && ma20Declining && bearishAlign) {
    return '淘汰11: 技術面全面轉壞（均線空排、股價在月線下、月線下彎），基本面好也勿進場';
  }
  return null;
}

/**
 * 嚴重淘汰條件：單獨命中 1 條即淘汰
 * 朱老師書中這些是明確的「不碰」情況，不需要其他條件配合
 */
const CRITICAL_ELIMINATION_RULES = [
  rule01_notOutOfBottom,    // 尚未走出底部（結構性問題）
  rule05_overExtended,      // 大幅上漲過高，漲超過1倍
  rule10_threeBlacks,       // 連3天長黑K（明確出貨）
  rule11_noTechnical,       // 技術面全面轉壞
];

/**
 * 一般淘汰條件：需 2 條以上同時命中才淘汰
 */
const STANDARD_ELIMINATION_RULES = [
  rule02_resistanceBlockBreakMA5,
  rule03_unclearTrend,
  rule04_noVolume,
  rule06_resistanceLongBlack,
  rule07_indicatorDivergence,
  rule08_institutionalSelling,
  rule09_highVolNoRise,
  rule10b_longConsolidation,
];

/**
 * 評估一支股票是否應被淘汰
 * @returns eliminated=true 表示強烈建議排除，penalty 為扣分
 */
export function evaluateElimination(
  candles: CandleWithIndicators[],
  idx: number,
): EliminationResult {
  const reasons: string[] = [];
  let hasCritical = false;

  for (const rule of CRITICAL_ELIMINATION_RULES) {
    try {
      const reason = rule(candles, idx);
      if (reason) { reasons.push(reason); hasCritical = true; }
    } catch { /* skip */ }
  }

  for (const rule of STANDARD_ELIMINATION_RULES) {
    try {
      const reason = rule(candles, idx);
      if (reason) reasons.push(reason);
    } catch { /* skip */ }
  }

  // 嚴重條件（R1/R5/R10/R11）1 條即淘汰；一般條件需 2 條以上
  const eliminated = hasCritical || reasons.length >= 2;
  // 每條扣 3 分，最多扣 20
  const penalty = Math.min(reasons.length * 3, 20);

  return { eliminated, reasons, penalty };
}
