/**
 * 缺口 detector — 書本 Part 9 p.584-643
 *
 * 實作：
 *   - 5 種向上缺口（p.591-602）：跌深反彈/島型反轉/突破缺口/逃逸缺口/竭盡缺口
 *   - 5 種向下缺口（p.605-612）鏡像
 *   - 缺口 4 關鍵位置 ABCDE（p.617-621）
 *   - 真封口 vs 假封口（p.625-632）
 *   - 3 日 2 缺口（p.635-639）
 *   - 隱形缺口（p.640-643）
 *   - 島型反轉（p.593, p.607）
 */
import type { CandleWithIndicators } from '@/types';

// ────────────────────────────────────────────────────────────────
// 基礎：偵測跳空缺口
// ────────────────────────────────────────────────────────────────

/** 向上跳空：當日 low > 前日 high */
export function hasGapUp(prev: CandleWithIndicators, c: CandleWithIndicators): boolean {
  return c.low > prev.high;
}

/** 向下跳空：當日 high < 前日 low */
export function hasGapDown(prev: CandleWithIndicators, c: CandleWithIndicators): boolean {
  return c.high < prev.low;
}

// ────────────────────────────────────────────────────────────────
// 缺口 4 位置 ABCDE（書本 p.617）
// 向上缺口：上高價 / 上沿價 / 下沿價 / 下底價
// ────────────────────────────────────────────────────────────────

export interface GapUpPrices {
  upHigh:    number;  // A: 缺口後紅K最高（最強支撐）
  upBottom:  number;  // B: 缺口後紅K最低（次強）
  downTop:   number;  // D: 缺口前紅K最高（較弱）
  downLow:   number;  // E: 缺口前紅K最低（最弱，跌破多空易位）
}

export function gapUpKeyPrices(
  prev: CandleWithIndicators,  // 缺口前
  c:    CandleWithIndicators,  // 缺口後
): GapUpPrices | null {
  if (!hasGapUp(prev, c)) return null;
  return {
    upHigh:   c.high,
    upBottom: c.low,
    downTop:  prev.high,
    downLow:  prev.low,
  };
}

// ────────────────────────────────────────────────────────────────
// 5 種向上缺口分類（書本 p.591-602）
// ────────────────────────────────────────────────────────────────

export type GapUpType =
  | 'rebound'      // 跌深反彈（空頭反彈，不是多頭）
  | 'island'       // 島型反轉（左右都有缺口，大漲前兆）
  | 'breakout'     // 突破缺口（打底完成大量突破）
  | 'runaway'      // 逃逸缺口（多頭上漲中）
  | 'exhaustion';  // 竭盡缺口（末升段）

export function classifyGapUp(
  candles: CandleWithIndicators[],
  index: number,
): GapUpType | null {
  if (index < 1) return null;
  const c = candles[index];
  const prev = candles[index - 1];
  if (!hasGapUp(prev, c)) return null;

  // 空頭低檔 → 跌深反彈
  if (c.ma20 && c.close < c.ma20) return 'rebound';

  // 島型反轉：前後都有缺口（前方向下跳空 + 後方向上跳空）
  if (index >= 2) {
    const p2 = candles[index - 2];
    if (hasGapDown(p2, prev)) return 'island';
  }

  // 末升段竭盡：近 3 天連漲 + 高乖離（>15%）
  const highDev = c.ma20 && c.ma20 > 0 && (c.close - c.ma20) / c.ma20 > 0.15;
  if (highDev && index >= 3) {
    const consec3Up =
      candles[index - 1].close > candles[index - 2].close &&
      candles[index - 2].close > candles[index - 3].close;
    if (consec3Up) return 'exhaustion';
  }

  // 底部打底突破（近 20 天收盤 < MA20 後首次突破）
  let wasBelow = false;
  for (let j = Math.max(0, index - 20); j < index; j++) {
    if (candles[j].ma20 && candles[j].close < candles[j].ma20!) { wasBelow = true; break; }
  }
  if (wasBelow && c.ma20 && c.close > c.ma20) return 'breakout';

  // 否則：行進中逃逸缺口
  return 'runaway';
}

/** 向下缺口分類（鏡像） */
export type GapDownType =
  | 'pullback'     // 漲多回檔（多頭回檔）
  | 'island'       // 島型反轉（高檔）
  | 'breakdown'    // 做頭完成跌破缺口
  | 'runaway'      // 下跌逃逸
  | 'exhaustion';  // 末跌段

export function classifyGapDown(
  candles: CandleWithIndicators[],
  index: number,
): GapDownType | null {
  if (index < 1) return null;
  const c = candles[index];
  const prev = candles[index - 1];
  if (!hasGapDown(prev, c)) return null;

  if (c.ma20 && c.close > c.ma20) return 'pullback';

  if (index >= 2) {
    const p2 = candles[index - 2];
    if (hasGapUp(p2, prev)) return 'island';
  }

  const lowDev = c.ma20 && c.ma20 > 0 && (c.close - c.ma20) / c.ma20 < -0.15;
  if (lowDev && index >= 3) {
    const consec3Down =
      candles[index - 1].close < candles[index - 2].close &&
      candles[index - 2].close < candles[index - 3].close;
    if (consec3Down) return 'exhaustion';
  }

  let wasAbove = false;
  for (let j = Math.max(0, index - 20); j < index; j++) {
    if (candles[j].ma20 && candles[j].close > candles[j].ma20!) { wasAbove = true; break; }
  }
  if (wasAbove && c.ma20 && c.close < c.ma20) return 'breakdown';

  return 'runaway';
}

// ────────────────────────────────────────────────────────────────
// 真封口 vs 假封口（書本 p.625-632）
// ────────────────────────────────────────────────────────────────

/** 真封口：大量黑K 收盤跌破向上缺口下沿 → 缺口失效 */
export function isTrueGapFillUp(
  candles: CandleWithIndicators[],
  gapIdx: number,       // 原缺口當天 index
  fillIdx: number,      // 封口當天
): boolean {
  if (gapIdx < 1) return false;
  const gapPrev = candles[gapIdx - 1];
  const gapDay = candles[gapIdx];
  const fillDay = candles[fillIdx];
  if (!hasGapUp(gapPrev, gapDay)) return false;

  const bodyPct = fillDay.open > 0 ? Math.abs(fillDay.close - fillDay.open) / fillDay.open : 0;
  const isBigBlack = fillDay.close < fillDay.open && bodyPct >= 0.02;
  const avgVol5 = fillDay.avgVol5 ?? 0;
  const isLargeVol = avgVol5 > 0 && fillDay.volume >= avgVol5 * 1.5;
  return isBigBlack && isLargeVol && fillDay.close <= gapDay.low;
}

// ────────────────────────────────────────────────────────────────
// 3 日 2 缺口（書本 p.635-639）
// ────────────────────────────────────────────────────────────────

export function detectTwoGapsInThreeDays(
  candles: CandleWithIndicators[],
  index: number,
): { up: boolean; down: boolean } {
  if (index < 2) return { up: false, down: false };
  const c0 = candles[index - 2];
  const c1 = candles[index - 1];
  const c2 = candles[index];

  const gap1Up = hasGapUp(c0, c1);
  const gap2Up = hasGapUp(c1, c2);
  const gap1Down = hasGapDown(c0, c1);
  const gap2Down = hasGapDown(c1, c2);

  return { up: gap1Up && gap2Up, down: gap1Down && gap2Down };
}

// ────────────────────────────────────────────────────────────────
// 隱形缺口（書本 p.640-643）
// 當日開盤 vs 前日收盤有跳空，收盤填補（不留在 K 線間）
// ────────────────────────────────────────────────────────────────

export function detectHiddenGap(
  candles: CandleWithIndicators[],
  index: number,
): 'up' | 'down' | null {
  if (index < 1) return null;
  const prev = candles[index - 1];
  const c = candles[index];
  // 開盤跳空但 high/low 與前日 high/low 有重疊（表示盤中回補）
  if (c.open > prev.close && c.low < prev.high) return 'up';
  if (c.open < prev.close && c.high > prev.low) return 'down';
  return null;
}

// ────────────────────────────────────────────────────────────────
// 島型反轉（書本 p.593, p.607）
// 低檔：向下缺口 + 底部盤整 + 向上缺口 → 大漲前兆
// 高檔：向上缺口 + 頂部盤整 + 向下缺口 → 大跌前兆
// ────────────────────────────────────────────────────────────────

export function detectIslandReversal(
  candles: CandleWithIndicators[],
  index: number,
  maxIslandDays = 5,
): 'bottom' | 'top' | null {
  if (index < 2) return null;
  const c = candles[index];
  const prev = candles[index - 1];

  // 底部島型：今天向上跳空，之前 maxIslandDays 內有向下跳空
  if (hasGapUp(prev, c)) {
    for (let j = Math.max(1, index - maxIslandDays); j < index; j++) {
      const p = candles[j - 1];
      const q = candles[j];
      if (hasGapDown(p, q)) return 'bottom';
    }
  }

  // 頂部島型：今天向下跳空，之前有向上跳空
  if (hasGapDown(prev, c)) {
    for (let j = Math.max(1, index - maxIslandDays); j < index; j++) {
      const p = candles[j - 1];
      const q = candles[j];
      if (hasGapUp(p, q)) return 'top';
    }
  }

  return null;
}
