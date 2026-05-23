/**
 * 週線 W 底型態（Phase 3.2）— N 字母子型態
 *
 * 書本來源（rule #5 對齊）：
 *   - 朱家泓《活用技術分析寶典》Part 7-3 多時間框架
 *   - 《抓住飆股 25 型態》#W 底
 *   - 核心：日線 V 反轉若同時是週線 W 底突破，是「多時間框架共振」，成功率最高
 *
 * 模組定位：N 字母子型態 `N_weeklyW`，不是新字母
 *   - 與 N（V 反轉）並列輸出
 *   - 主掃描預設不啟用（StrategyConfig.enhancedSelection.weeklyW = false）
 *
 * 偵測規則：
 *   1. 取最近 12 週 K
 *   2. 找兩個低點（左底 / 右底）— 兩底之差 ≤ 5%（不破底）
 *   3. 兩底中間有 peak（neckline）— peak > 兩底 × 1.05
 *   4. 突破 neckline 當週 close > neckline
 *   5. 突破週量 ≥ 過去 4 週均量 × 1.3
 *
 * 不變式：
 *   - 純函式
 *   - 不讀檔
 *   - 「W 底」必須右底 ≥ 左底（破底就不是 W 底，是空頭續跌）
 */

export const WEEKLY_W_BOOK_REF = {
  book: '朱家泓《活用技術分析寶典》',
  part: 'Part 7-3 多時間框架 + 《抓住飆股 25 型態》#W 底',
  topic: '週線 W 底突破多時間框架共振',
  rule: 'N_sub_pattern',  // 不是新字母
} as const;

export interface WeeklyCandle {
  weekStart: string;          // YYYY-MM-DD（週一）
  weekEnd: string;            // YYYY-MM-DD（週五）
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface WeeklyWResult {
  detected: boolean;
  /** 命中關鍵點（給後續走圖標記）*/
  leftBottomWeek?: string;    // weekEnd date
  leftBottomLow?: number;
  middlePeakWeek?: string;
  middlePeakHigh?: number;
  rightBottomWeek?: string;
  rightBottomLow?: number;
  necklinePrice?: number;
  breakoutWeek?: string;
  breakoutClose?: number;
  breakoutVolume?: number;
  breakoutVolumeMultiple?: number;  // 突破週量 / 4 週均量
  reason: string;
}

const LOOKBACK_WEEKS = 12;
const MAX_BOTTOM_DIFF_PCT = 0.05;     // 兩底之差不超過 5%
const MIN_PEAK_ABOVE_BOTTOM_PCT = 0.05;  // peak 至少高過兩底 5%
const VOLUME_BREAKOUT_MULTIPLIER = 1.3;

/** 把日 K 線聚合成週 K 線（週一到週五）*/
export function aggregateDailyToWeekly(daily: ReadonlyArray<{
  date: string; open: number; high: number; low: number; close: number; volume: number;
}>): WeeklyCandle[] {
  if (daily.length === 0) return [];
  const byWeek = new Map<string, typeof daily[number][]>();
  for (const d of daily) {
    // 算該 date 所屬的週（用 ISO week，週一為起）
    const dt = new Date(d.date);
    const dayOfWeek = (dt.getDay() + 6) % 7;  // 週一=0
    const monday = new Date(dt.getTime() - dayOfWeek * 86400 * 1000);
    const weekKey = monday.toISOString().slice(0, 10);
    if (!byWeek.has(weekKey)) byWeek.set(weekKey, []);
    byWeek.get(weekKey)!.push(d);
  }
  const out: WeeklyCandle[] = [];
  for (const [weekStart, days] of Array.from(byWeek.entries()).sort()) {
    if (days.length === 0) continue;
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    out.push({
      weekStart,
      weekEnd: sorted[sorted.length - 1].date,
      open: sorted[0].open,
      high: Math.max(...sorted.map(d => d.high)),
      low: Math.min(...sorted.map(d => d.low)),
      close: sorted[sorted.length - 1].close,
      volume: sorted.reduce((s, d) => s + d.volume, 0),
    });
  }
  return out;
}

/** 在週 K 線內偵測 W 底突破 */
export function detectWeeklyW(weekly: ReadonlyArray<WeeklyCandle>): WeeklyWResult {
  if (weekly.length < LOOKBACK_WEEKS) {
    return { detected: false, reason: `週 K 不足 ${LOOKBACK_WEEKS} 根（got ${weekly.length}）` };
  }

  const window = weekly.slice(-LOOKBACK_WEEKS);
  const latest = window[window.length - 1];

  // 找窗內最低點（候選 leftBottom 或 rightBottom）
  // 簡化策略：把 window 分為左半（前 60%）和右半（後 40%）
  const splitIdx = Math.floor(window.length * 0.6);
  const leftHalf = window.slice(0, splitIdx);
  const rightHalf = window.slice(splitIdx, window.length - 1);  // 不含最後一根（保留為突破週候選）

  if (leftHalf.length === 0 || rightHalf.length === 0) {
    return { detected: false, reason: '左/右半窗為空' };
  }

  const leftBottomIdx = leftHalf.reduce((bestIdx, c, i) => c.low < leftHalf[bestIdx].low ? i : bestIdx, 0);
  const leftBottom = leftHalf[leftBottomIdx];
  const rightBottomIdx = rightHalf.reduce((bestIdx, c, i) => c.low < rightHalf[bestIdx].low ? i : bestIdx, 0);
  const rightBottom = rightHalf[rightBottomIdx];

  // 破底檢查（W 底基本要求：右底不可顯著低於左底）
  // 注意：放在「不對稱」檢查之前，因為「破底」是更嚴重的 disqualification
  if (rightBottom.low < leftBottom.low * (1 - MAX_BOTTOM_DIFF_PCT)) {
    return {
      detected: false,
      leftBottomWeek: leftBottom.weekEnd,
      leftBottomLow: leftBottom.low,
      rightBottomWeek: rightBottom.weekEnd,
      rightBottomLow: rightBottom.low,
      reason: `右底 ${rightBottom.low} < 左底 ${leftBottom.low} 超過 ${(MAX_BOTTOM_DIFF_PCT * 100).toFixed(0)}%，破底非 W 型態`,
    };
  }

  // 兩底不對稱（右底高過左底太多）
  const bottomDiff = Math.abs(rightBottom.low - leftBottom.low) / leftBottom.low;
  if (bottomDiff > MAX_BOTTOM_DIFF_PCT) {
    return {
      detected: false,
      leftBottomWeek: leftBottom.weekEnd,
      leftBottomLow: leftBottom.low,
      rightBottomWeek: rightBottom.weekEnd,
      rightBottomLow: rightBottom.low,
      reason: `兩底差 ${(bottomDiff * 100).toFixed(1)}% > ${(MAX_BOTTOM_DIFF_PCT * 100).toFixed(0)}%（不對稱）`,
    };
  }

  // 中間 peak（leftBottom 之後、rightBottom 之前）
  const leftBottomAbsIdx = leftBottomIdx;
  const rightBottomAbsIdx = splitIdx + rightBottomIdx;
  const middleSlice = window.slice(leftBottomAbsIdx + 1, rightBottomAbsIdx);
  if (middleSlice.length === 0) {
    return { detected: false, reason: '兩底之間無 peak 候選' };
  }
  const middlePeak = middleSlice.reduce((best, c) => c.high > best.high ? c : best, middleSlice[0]);
  const peakAboveBottoms = (middlePeak.high - Math.max(leftBottom.low, rightBottom.low))
    / Math.max(leftBottom.low, rightBottom.low);
  if (peakAboveBottoms < MIN_PEAK_ABOVE_BOTTOM_PCT) {
    return {
      detected: false,
      leftBottomWeek: leftBottom.weekEnd,
      rightBottomWeek: rightBottom.weekEnd,
      middlePeakWeek: middlePeak.weekEnd,
      middlePeakHigh: middlePeak.high,
      reason: `peak ${middlePeak.high} 高過兩底僅 ${(peakAboveBottoms * 100).toFixed(1)}% < ${(MIN_PEAK_ABOVE_BOTTOM_PCT * 100).toFixed(0)}%`,
    };
  }

  // 突破：最新週 close > neckline (peak)
  const neckline = middlePeak.high;
  if (latest.close <= neckline) {
    return {
      detected: false,
      leftBottomWeek: leftBottom.weekEnd,
      rightBottomWeek: rightBottom.weekEnd,
      middlePeakWeek: middlePeak.weekEnd,
      middlePeakHigh: middlePeak.high,
      necklinePrice: neckline,
      reason: `最新週 close ${latest.close} ≤ neckline ${neckline}，未突破`,
    };
  }

  // 量能：突破週量 ≥ 過去 4 週均量 × 1.3
  const past4 = window.slice(-5, -1);  // 倒數第 2 到第 5 週
  const past4AvgVolume = past4.reduce((s, c) => s + c.volume, 0) / past4.length;
  const breakoutVolMult = past4AvgVolume > 0 ? latest.volume / past4AvgVolume : 0;
  if (breakoutVolMult < VOLUME_BREAKOUT_MULTIPLIER) {
    return {
      detected: false,
      leftBottomWeek: leftBottom.weekEnd,
      rightBottomWeek: rightBottom.weekEnd,
      middlePeakWeek: middlePeak.weekEnd,
      necklinePrice: neckline,
      breakoutWeek: latest.weekEnd,
      breakoutClose: latest.close,
      breakoutVolume: latest.volume,
      breakoutVolumeMultiple: +breakoutVolMult.toFixed(2),
      reason: `突破週量 ${latest.volume.toLocaleString()} / 4 週均 ${Math.round(past4AvgVolume).toLocaleString()} = ${breakoutVolMult.toFixed(2)}x < ${VOLUME_BREAKOUT_MULTIPLIER}x`,
    };
  }

  return {
    detected: true,
    leftBottomWeek: leftBottom.weekEnd,
    leftBottomLow: leftBottom.low,
    middlePeakWeek: middlePeak.weekEnd,
    middlePeakHigh: middlePeak.high,
    rightBottomWeek: rightBottom.weekEnd,
    rightBottomLow: rightBottom.low,
    necklinePrice: neckline,
    breakoutWeek: latest.weekEnd,
    breakoutClose: latest.close,
    breakoutVolume: latest.volume,
    breakoutVolumeMultiple: +breakoutVolMult.toFixed(2),
    reason: `W 底突破：左底 ${leftBottom.low}、右底 ${rightBottom.low}、neckline ${neckline}；突破週 close ${latest.close}、量 ${breakoutVolMult.toFixed(2)}x`,
  };
}

export const WEEKLY_W_CONST = {
  LOOKBACK_WEEKS,
  MAX_BOTTOM_DIFF_PCT,
  MIN_PEAK_ABOVE_BOTTOM_PCT,
  VOLUME_BREAKOUT_MULTIPLIER,
} as const;
