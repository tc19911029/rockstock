/**
 * 融資斷頭壓力分數（0–100，5 個 20 分子項；多方/下跌方向）
 *
 *   1. 融資累積（融資餘額近期增加 = 散戶加槓桿）
 *   2. 融資使用率偏高
 *   3. 跌破融資成本（套牢，5/10/20/60d）
 *   4. 斷頭壓力（距斷頭價遠近）
 *   5. 量價走弱（放量下跌、破前低、跌破均線、長黑）
 *
 *   等級：0–30 低 / 31–50 微 / 51–70 潛在 / 71–85 高 / 86–100 極高
 *
 * 對照 lib/squeeze/squeezeScorer.ts（空方/上漲方向），結構鏡像、方向相反。
 */

import type { MarginDay, PriceDay } from '@/lib/squeeze/types';
import type { CostBucket, MarginLiquidationScore } from './types';

interface MarginScoreInput {
  margin: MarginDay[];
  prices: PriceDay[];
  marginCosts: CostBucket;
  liquidationPrice: number | null;
  close: number;
}

const last = <T>(arr: T[]): T | undefined => arr[arr.length - 1];

function changeOverWindow(arr: number[], n: number): number {
  if (arr.length < n + 1) return 0;
  return arr[arr.length - 1] - arr[arr.length - 1 - n];
}

function sma(arr: number[], n: number): number | null {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((s, x) => s + x, 0) / n;
}

export function computeMarginLiquidationScore(input: MarginScoreInput): MarginLiquidationScore {
  const { margin, prices, marginCosts, liquidationPrice: liq, close } = input;

  // ── 1. 融資累積（最高 20）── 餘額增加 = 散戶加槓桿
  let marginAccumulation = 0;
  const marginBal = margin.map(m => m.marginBalance);
  if (changeOverWindow(marginBal, 5) > 0) marginAccumulation += 5;
  if (changeOverWindow(marginBal, 10) > 0) marginAccumulation += 5;
  if (changeOverWindow(marginBal, 20) > 0) marginAccumulation += 5;
  const last60 = marginBal.slice(-60);
  if (last60.length >= 20) {
    const cur = last60[last60.length - 1];
    const sorted = [...last60].sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)];
    if (cur >= p80) marginAccumulation += 5;
  }

  // ── 2. 融資使用率偏高（最高 20）──
  let utilizationHigh = 0;
  const util = last(margin)?.marginUtilRate ?? 0;
  if (util > 40) utilizationHigh += 5;
  if (util > 60) utilizationHigh += 5;
  if (util > 80) utilizationHigh += 5;
  // 近 5 日融資持續淨增（追高）
  const marginNet5 = margin.slice(-5).reduce((s, m) => s + m.marginNet, 0);
  if (marginNet5 > 0) utilizationHigh += 5;

  // ── 3. 跌破融資成本（最高 20）── close < cost = 套牢
  let belowMarginCost = 0;
  const cb = marginCosts;
  if (cb.d5  !== null && close < cb.d5)  belowMarginCost += 5;
  if (cb.d10 !== null && close < cb.d10) belowMarginCost += 5;
  if (cb.d20 !== null && close < cb.d20) belowMarginCost += 5;
  if (cb.d60 !== null && close < cb.d60) belowMarginCost += 5;

  // ── 4. 斷頭壓力（最高 20）── 距斷頭價越近越危險
  let liquidationPressure = 0;
  if (liq !== null && liq > 0) {
    const buf = (close - liq) / liq;  // 現價在斷頭價之上多少
    if (buf <= 0.25) liquidationPressure += 5;
    if (buf <= 0.15) liquidationPressure += 5;
    if (buf <= 0.08) liquidationPressure += 5;
    if (close <= liq * 1.05) liquidationPressure += 5;
  }

  // ── 5. 量價走弱（最高 20）──
  let breakdownVolume = 0;
  const vols = prices.map(p => p.volume);
  const closes = prices.map(p => p.close);
  const lows = prices.map(p => p.low);
  const lastVol = last(vols) ?? 0;
  const v5 = sma(vols, 5);
  const lastP = last(prices);
  const down = lastP ? lastP.close < lastP.open : false;
  if (v5 !== null && lastVol > v5 && down) breakdownVolume += 5;   // 放量下跌
  if (lows.length >= 21) {
    const prevLow = Math.min(...prices.slice(-21, -1).map(p => p.low));
    if (close < prevLow) breakdownVolume += 5;                     // 跌破前 20 日低
  }
  const ma20 = sma(closes, 20);
  if (ma20 !== null && close < ma20) breakdownVolume += 5;         // 跌破 MA20
  const isLongBlack = !!lastP && lastP.open > 0 && (lastP.open - lastP.close) / lastP.open >= 0.03;
  if (isLongBlack) breakdownVolume += 5;                           // 長黑

  const total = marginAccumulation + utilizationHigh + belowMarginCost + liquidationPressure + breakdownVolume;
  const { level, levelLabel } = levelOf(total);

  return { marginAccumulation, utilizationHigh, belowMarginCost, liquidationPressure, breakdownVolume, total, level, levelLabel };
}

function levelOf(total: number): { level: MarginLiquidationScore['level']; levelLabel: string } {
  if (total <= 30) return { level: 'low',       levelLabel: '融資斷頭壓力低' };
  if (total <= 50) return { level: 'mild',      levelLabel: '融資微壓力' };
  if (total <= 70) return { level: 'potential', levelLabel: '潛在斷頭風險' };
  if (total <= 85) return { level: 'high',      levelLabel: '融資斷頭壓力高' };
  return                  { level: 'extreme',   levelLabel: '高度斷頭風險' };
}
