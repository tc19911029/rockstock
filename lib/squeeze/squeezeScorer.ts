/**
 * 軋空壓力分數（0–100，5 個 20 分子項）
 *
 *   1. 空單累積（融券+借券餘額是否近期增加）
 *   2. 跌不下去（低點墊高、空單增但沒破底）
 *   3. 站上空方成本（5/10/20/60d）
 *   4. 回補壓力（距追繳價遠近）
 *   5. 量價突破（量增、突破前高、長紅、站上均線）
 *
 *   等級：0–30 低 / 31–50 微 / 51–70 潛在 / 71–85 高 / 86–100 極高
 */

import type { MarginDay, SblDay, PriceDay, ShortCostBuckets, SqueezeSubScores } from './types';

interface ScoreInput {
  margin: MarginDay[];
  sbl: SblDay[];
  prices: PriceDay[];
  shortCosts: ShortCostBuckets;
  marginCallPrice: number | null;
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

export function computeSqueezeScore(input: ScoreInput): SqueezeSubScores {
  const { margin, sbl, prices, shortCosts, marginCallPrice: callPrice, close } = input;

  // ── 1. 空單累積（最高 20）─────────────────────────────────
  let shortAccumulation = 0;
  const shortBal = margin.map(m => m.shortBalance);
  const sblBal = sbl.map(s => s.lendingBalance);
  if (changeOverWindow(shortBal, 5) > 0 || changeOverWindow(sblBal, 5) > 0) shortAccumulation += 5;
  if (changeOverWindow(shortBal, 10) > 0 || changeOverWindow(sblBal, 10) > 0) shortAccumulation += 5;
  if (changeOverWindow(shortBal, 20) > 0 || changeOverWindow(sblBal, 20) > 0) shortAccumulation += 5;
  // 餘額位於近 60 日高檔（前 20%）
  const last60Short = shortBal.slice(-60);
  if (last60Short.length >= 20) {
    const curShort = last60Short[last60Short.length - 1];
    const sorted = [...last60Short].sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)];
    if (curShort >= p80) shortAccumulation += 5;
  }

  // ── 2. 跌不下去（最高 20）─────────────────────────────────
  let priceFloorRising = 0;
  const lows = prices.map(p => p.low);
  // 近 5 日低點墊高：取最後 5 日 vs 前 5 日（共 10 天）
  if (lows.length >= 10) {
    const recent5Min = Math.min(...lows.slice(-5));
    const prev5Min = Math.min(...lows.slice(-10, -5));
    if (recent5Min > prev5Min) priceFloorRising += 5;
  }
  if (lows.length >= 20) {
    const recent10Min = Math.min(...lows.slice(-10));
    const prev10Min = Math.min(...lows.slice(-20, -10));
    if (recent10Min > prev10Min) priceFloorRising += 5;
  }
  // 空單增但股價沒創低（近 20 日）
  if (changeOverWindow(shortBal, 20) > 0 && lows.length >= 20) {
    const min20 = Math.min(...lows.slice(-20));
    if (close > min20 * 1.03) priceFloorRising += 5;
  }
  // 站回 5 或 10 日線
  const closes = prices.map(p => p.close);
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  if ((ma5 !== null && close >= ma5) || (ma10 !== null && close >= ma10)) priceFloorRising += 5;

  // ── 3. 站上空方成本（最高 20）──────────────────────────────
  let aboveShortCost = 0;
  if (shortCosts.combined.d5  !== null && close > shortCosts.combined.d5)  aboveShortCost += 5;
  if (shortCosts.combined.d10 !== null && close > shortCosts.combined.d10) aboveShortCost += 5;
  if (shortCosts.combined.d20 !== null && close > shortCosts.combined.d20) aboveShortCost += 5;
  if (shortCosts.combined.d60 !== null && close > shortCosts.combined.d60) aboveShortCost += 5;

  // ── 4. 回補壓力（最高 20）—— 距追繳價遠近 + 浮虧幅度 ─────
  let marginCallPressure = 0;
  const ref = shortCosts.combined.d20 ?? shortCosts.combined.d10 ?? shortCosts.combined.d5 ?? null;
  if (ref !== null) {
    const pct = (close - ref) / ref;
    if (pct >= 0.05) marginCallPressure += 5;
    if (pct >= 0.10) marginCallPressure += 5;
    if (pct >= 0.20) marginCallPressure += 5;
  }
  if (callPrice && callPrice > 0 && close >= callPrice * 0.8) marginCallPressure += 5;

  // ── 5. 量價突破（最高 20）─────────────────────────────────
  let breakoutVolume = 0;
  const vols = prices.map(p => p.volume);
  const lastVol = last(vols) ?? 0;
  const v5 = sma(vols, 5);
  const v20 = sma(vols, 20);
  if (v5 !== null && lastVol > v5) breakoutVolume += 5;
  if (v20 !== null && lastVol > v20) breakoutVolume += 5;
  // 突破前 20 日高（不含當日）
  if (prices.length >= 21) {
    const prevHigh = Math.max(...prices.slice(-21, -1).map(p => p.high));
    if (close > prevHigh) breakoutVolume += 5;
  }
  // 長紅（收>開 > 3%）或站上 MA20
  const lastPrice = last(prices);
  const ma20 = sma(closes, 20);
  const longBullish = lastPrice && lastPrice.open > 0 && (lastPrice.close - lastPrice.open) / lastPrice.open >= 0.03;
  if (longBullish || (ma20 !== null && close >= ma20)) breakoutVolume += 5;

  const total = shortAccumulation + priceFloorRising + aboveShortCost + marginCallPressure + breakoutVolume;
  const { level, levelLabel } = levelOf(total);

  return { shortAccumulation, priceFloorRising, aboveShortCost, marginCallPressure, breakoutVolume, total, level, levelLabel };
}

function levelOf(total: number): { level: SqueezeSubScores['level']; levelLabel: string } {
  if (total <= 30) return { level: 'low',       levelLabel: '軋空壓力低' };
  if (total <= 50) return { level: 'mild',      levelLabel: '空方微壓力' };
  if (total <= 70) return { level: 'potential', levelLabel: '潛在軋空條件' };
  if (total <= 85) return { level: 'high',      levelLabel: '軋空壓力高' };
  return                  { level: 'extreme',   levelLabel: '高度軋空風險' };
}
