/**
 * 台股策略回測 Round 3 — 網上經驗證的量化策略
 *
 * 策略10: RSI(2) 均值回歸 (Larry Connors) — QQQ: Sharpe 2.85, WR 75%
 * 策略11: IBS 均值回歸 — SPY: Sharpe 1.7, WR 74%, PF 2.73
 * 策略12: Connors 3日高低法 — WR 72.3%, PF 1.53
 * 策略13: 缺口回填 — PF 1.8
 * 策略14: RSI(60) 長週期動能 — FinLab 台股研究
 * 策略15: 52週新高動能 — TEJ 台股研究
 *
 * Usage: npx tsx scripts/backtest-tw-round3.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { Candle, CandleWithIndicators } from '@/types';

const BACKTEST_START = '2023-07-01';
const BACKTEST_END   = '2026-03-31';
const INITIAL_CAPITAL = 1000000;
const ROUND_TRIP_COST = 0.44;

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles.json');

interface Trade {
  strategy: string;
  entryDate: string; exitDate: string;
  symbol: string; name: string;
  entryPrice: number; exitPrice: number;
  grossReturn: number; netReturn: number;
  holdDays: number; exitReason: string;
}

// ── 額外指標計算（不改 indicators.ts）─────────────────────────

/** RSI with custom period (Wilder smoothing) */
function computeCustomRSI(closes: number[], period: number): (number | undefined)[] {
  const result: (number | undefined)[] = new Array(closes.length).fill(undefined);
  if (closes.length < period + 1) return result;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
  }
  return result;
}

/** Enriched candle with extra indicators for Round 3 */
interface R3Candle extends CandleWithIndicators {
  rsi2?: number;
  rsi60?: number;
  ibs?: number;       // Internal Bar Strength
  high252?: number;   // 52-week (252-day) highest close
}

function enrichCandles(candles: CandleWithIndicators[]): R3Candle[] {
  const closes = candles.map(c => c.close);
  const rsi2arr = computeCustomRSI(closes, 2);
  const rsi60arr = computeCustomRSI(closes, 60);

  return candles.map((c, i) => {
    // IBS
    const range = c.high - c.low;
    const ibs = range > 0 ? +((c.close - c.low) / range).toFixed(4) : 0.5;

    // 52-week high
    let high252 = c.close;
    for (let j = Math.max(0, i - 252); j < i; j++) {
      high252 = Math.max(high252, candles[j].close);
    }

    return {
      ...c,
      rsi2: rsi2arr[i],
      rsi60: rsi60arr[i],
      ibs,
      high252,
    } as R3Candle;
  });
}

// ══════════════════════════════════════════════════════════════
// 策略10: RSI(2) 均值回歸 (Larry Connors)
// 進場: close > MA240 + RSI(2) < 5 + close < MA5
// 出場: close > MA5 或 RSI(2) > 70 或 持有10天（無傳統停損）
// ══════════════════════════════════════════════════════════════

function scanRSI2(candles: R3Candle[], idx: number): boolean {
  if (idx < 1) return false;
  const c = candles[idx];
  if (c.rsi2 == null || c.ma240 == null || c.ma5 == null) return false;

  // 長期趨勢: close > MA240 (≈MA200)
  if (c.close <= c.ma240) return false;

  // RSI(2) 極度超賣
  if (c.rsi2 >= 5) return false;

  // 短期弱勢: close < MA5
  if (c.close >= c.ma5) return false;

  return true;
}

function exitRSI2(
  candles: R3Candle[], entryIdx: number, entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  for (let d = 1; d <= 10; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];

    // 回到MA5上方
    if (c.ma5 != null && c.close > c.ma5) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '>MA5' };
    }

    // RSI(2) 回到70以上
    if (c.rsi2 != null && c.rsi2 > 70) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: 'RSI2>70' };
    }

    // Connors說不用停損，但加個極端保護 -15%
    if (c.low <= entryPrice * 0.85) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 0.85).toFixed(2), exitReason: '極端停損-15%' };
    }

    if (d === 10) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有10天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 策略11: IBS 均值回歸
// 進場: IBS < 0.2 + close > MA240
// 出場: IBS > 0.8 或 持有10天 或 停損-10%
// ══════════════════════════════════════════════════════════════

function scanIBS(candles: R3Candle[], idx: number): boolean {
  const c = candles[idx];
  if (c.ibs == null || c.ma240 == null) return false;

  // IBS 極低（收在當日低點附近）
  if (c.ibs >= 0.2) return false;

  // 長期趨勢向上
  if (c.close <= c.ma240) return false;

  return true;
}

function exitIBS(
  candles: R3Candle[], entryIdx: number, entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  for (let d = 1; d <= 10; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];

    // IBS 回到高位
    if (c.ibs != null && c.ibs > 0.8) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: 'IBS>0.8' };
    }

    // 停損 -10%
    if (c.low <= entryPrice * 0.90) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 0.90).toFixed(2), exitReason: '停損-10%' };
    }

    if (d === 10) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有10天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 策略12: Connors 3日高低法
// 進場: close > MA240 + close < MA5 + 連續3天 lower-high & lower-low
// 出場: close > MA5
// ══════════════════════════════════════════════════════════════

function scan3DayHighLow(candles: R3Candle[], idx: number): boolean {
  if (idx < 3) return false;
  const c = candles[idx];
  if (c.ma240 == null || c.ma5 == null) return false;

  // 長期趨勢
  if (c.close <= c.ma240) return false;

  // 短期弱勢
  if (c.close >= c.ma5) return false;

  // 連續3天 lower-high AND lower-low
  for (let d = 0; d < 3; d++) {
    const curr = candles[idx - d];
    const prev = candles[idx - d - 1];
    if (curr.high >= prev.high || curr.low >= prev.low) return false;
  }

  return true;
}

function exit3DayHighLow(
  candles: R3Candle[], entryIdx: number, entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  for (let d = 1; d <= 15; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];

    // close > MA5
    if (c.ma5 != null && c.close > c.ma5) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '>MA5' };
    }

    // 極端停損 -15%
    if (c.low <= entryPrice * 0.85) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 0.85).toFixed(2), exitReason: '極端停損-15%' };
    }

    if (d === 15) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有15天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 策略13: 缺口回填 (Gap-Down Reversion)
// 進場: 前日 close > MA240 + 今日開盤跳空>2% + RSI(2)<10
// 出場: 當日收盤（T+0）或 停損-3%
// 注意: 這個策略用「當日收盤」進出，不是隔日開盤
// ══════════════════════════════════════════════════════════════

function scanGapDown(candles: R3Candle[], idx: number): boolean {
  if (idx < 1) return false;
  const today = candles[idx];
  const yesterday = candles[idx - 1];
  if (yesterday.ma240 == null || today.rsi2 == null) return false;

  // 前日趨勢向上
  if (yesterday.close <= yesterday.ma240) return false;

  // 跳空下跌 > 2%（但不超過7%，太大的缺口是真壞消息）
  const gapPct = (today.open - yesterday.close) / yesterday.close;
  if (gapPct >= -0.02) return false; // 至少跳空2%
  if (gapPct < -0.07) return false;  // 不超過7%

  // RSI(2) 確認超賣
  // 用前一天的RSI(2)，因為今天的還沒收盤
  if (idx >= 2) {
    const prevRSI2 = candles[idx - 1].rsi2;
    if (prevRSI2 != null && prevRSI2 >= 20) return false;
  }

  return true;
}

// 缺口策略特殊: 開盤買 + 當日收盤賣（T+0）
// 不用通用的回測引擎，直接在 main 裡處理

// ══════════════════════════════════════════════════════════════
// 策略14: RSI(60) 長週期動能 (FinLab 台股研究)
// 進場: RSI(60) 穿越55以上 + close > MA20 + close > MA60 + vol > avgVol20*1.2
// 出場: RSI(60) < 45 或 close < MA60 或 追蹤停損-8%
// ══════════════════════════════════════════════════════════════

function scanRSI60(candles: R3Candle[], idx: number): boolean {
  if (idx < 1) return false;
  const today = candles[idx];
  const yesterday = candles[idx - 1];
  if (today.rsi60 == null || yesterday.rsi60 == null) return false;
  if (today.ma20 == null || today.ma60 == null || today.avgVol20 == null) return false;

  // RSI(60) 穿越55以上
  if (yesterday.rsi60 >= 55) return false; // 昨天在55以下
  if (today.rsi60 < 55) return false;      // 今天穿越到55以上

  // 趨勢確認
  if (today.close <= today.ma20) return false;
  if (today.close <= today.ma60) return false;

  // 量能
  if (today.volume < today.avgVol20 * 1.2) return false;

  return true;
}

function exitRSI60(
  candles: R3Candle[], entryIdx: number, entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  let trailHigh = entryPrice;

  for (let d = 1; d <= 30; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];
    trailHigh = Math.max(trailHigh, c.high);

    // RSI(60) < 45
    if (c.rsi60 != null && c.rsi60 < 45) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: 'RSI60<45' };
    }

    // 跌破 MA60
    if (c.ma60 != null && c.close < c.ma60) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '破MA60' };
    }

    // 追蹤停損 -8%
    if (c.low <= trailHigh * 0.92) {
      return { exitIdx: fi, exitPrice: +(trailHigh * 0.92).toFixed(2), exitReason: '追蹤停損-8%' };
    }

    if (d === 30) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有30天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 策略15: 52週新高動能 (TEJ 台股研究)
// 進場: close / 252日最高 > 0.95 + close > MA20 + 紅K + 量
// 出場: close < MA20 或 停損-10% 或 持有20天
// ══════════════════════════════════════════════════════════════

function scan52WeekHigh(candles: R3Candle[], idx: number): boolean {
  const c = candles[idx];
  if (c.high252 == null || c.ma20 == null || c.avgVol5 == null) return false;
  if (c.high252 === 0) return false;

  // 接近52週新高（95%以上）
  const ratio = c.close / c.high252;
  if (ratio < 0.95) return false;

  // MA20上方
  if (c.close <= c.ma20) return false;

  // 紅K
  if (c.close <= c.open) return false;

  // 量能
  if (c.volume < c.avgVol5 * 0.8) return false;

  // 不要已經大幅超過52週高的（可能是假突破後回來）
  if (ratio > 1.05) return false;

  return true;
}

function exit52WeekHigh(
  candles: R3Candle[], entryIdx: number, entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  for (let d = 1; d <= 20; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) return null;
    const c = candles[fi];

    // 停損 -10%
    if (c.low <= entryPrice * 0.90) {
      return { exitIdx: fi, exitPrice: +(entryPrice * 0.90).toFixed(2), exitReason: '停損-10%' };
    }

    // 跌破 MA20
    if (c.ma20 != null && c.close < c.ma20) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '破MA20' };
    }

    if (d === 20) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '持有20天' };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 回測引擎
// ══════════════════════════════════════════════════════════════

function runBacktest(
  name: string,
  allStocks: Map<string, { name: string; candles: R3Candle[] }>,
  tradingDays: string[],
  scanFn: (candles: R3Candle[], idx: number) => boolean,
  exitFn: (candles: R3Candle[], entryIdx: number, entryPrice: number, signalIdx: number) => { exitIdx: number; exitPrice: number; exitReason: string } | null,
): Trade[] {
  const trades: Trade[] = [];
  let holdingUntilDay = -1;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date = tradingDays[dayIdx];
    if (dayIdx <= holdingUntilDay) continue;

    interface Candidate {
      symbol: string; name: string; candles: R3Candle[];
      signalIdx: number; score: number;
    }
    const candidates: Candidate[] = [];

    for (const [symbol, stockData] of allStocks) {
      const { candles } = stockData;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 60 || idx >= candles.length - 30) continue;

      if (!scanFn(candles, idx)) continue;

      const c = candles[idx];
      // 排序: 越超賣越優先（RSI2低、IBS低）或 越強越優先
      const volRatio = c.avgVol5 && c.avgVol5 > 0 ? c.volume / c.avgVol5 : 1;
      const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
      candidates.push({ symbol, name: stockData.name, candles, signalIdx: idx, score: bodyPct * volRatio });
    }

    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[0];

    const entryIdx = pick.signalIdx + 1;
    if (entryIdx >= pick.candles.length) continue;
    const entryPrice = pick.candles[entryIdx].open;
    const entryDate = pick.candles[entryIdx].date?.slice(0, 10) ?? '';

    const exit = exitFn(pick.candles, entryIdx, entryPrice, pick.signalIdx);
    if (!exit) continue;

    const grossReturn = +((exit.exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
    const netReturn = +(grossReturn - ROUND_TRIP_COST).toFixed(2);
    const holdDays = exit.exitIdx - entryIdx;
    const exitDate = pick.candles[exit.exitIdx]?.date?.slice(0, 10) ?? '';
    const exitDayIdx = tradingDays.indexOf(exitDate);
    holdingUntilDay = exitDayIdx >= 0 ? exitDayIdx : dayIdx + holdDays;

    trades.push({
      strategy: name, entryDate, exitDate,
      symbol: pick.symbol, name: pick.name,
      entryPrice, exitPrice: exit.exitPrice,
      grossReturn, netReturn, holdDays, exitReason: exit.exitReason,
    });
  }
  return trades;
}

/** 缺口策略的特殊回測（T+0: 開盤買、收盤賣） */
function runGapBacktest(
  allStocks: Map<string, { name: string; candles: R3Candle[] }>,
  tradingDays: string[],
): Trade[] {
  const trades: Trade[] = [];

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date = tradingDays[dayIdx];

    interface Candidate {
      symbol: string; name: string;
      candles: R3Candle[]; idx: number;
      gapPct: number; score: number;
    }
    const candidates: Candidate[] = [];

    for (const [symbol, stockData] of allStocks) {
      const { candles } = stockData;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 60 || idx >= candles.length) continue;

      if (!scanGapDown(candles, idx)) continue;

      const gapPct = (candles[idx].open - candles[idx - 1].close) / candles[idx - 1].close * 100;
      // 越小的缺口回填率越高，優先選小缺口
      candidates.push({
        symbol, name: stockData.name, candles, idx,
        gapPct, score: -Math.abs(gapPct), // 小缺口優先
      });
    }

    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[0];

    const c = pick.candles[pick.idx];
    const entryPrice = c.open;

    // 停損檢查: 如果日內最低跌超過3%就停損
    const lowReturn = (c.low - entryPrice) / entryPrice * 100;
    let exitPrice: number, exitReason: string;
    if (lowReturn <= -3) {
      exitPrice = +(entryPrice * 0.97).toFixed(2);
      exitReason = '停損-3%';
    } else {
      exitPrice = c.close;
      exitReason = '當日收盤';
    }

    const grossReturn = +((exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
    const netReturn = +(grossReturn - ROUND_TRIP_COST).toFixed(2);

    trades.push({
      strategy: '缺口回填', entryDate: date, exitDate: date,
      symbol: pick.symbol, name: pick.name,
      entryPrice, exitPrice,
      grossReturn, netReturn, holdDays: 0, exitReason,
    });
  }
  return trades;
}

// ══════════════════════════════════════════════════════════════
// 統計 + 輸出
// ══════════════════════════════════════════════════════════════

interface Stats {
  name: string; trades: Trade[];
  totalTrades: number; wins: number; losses: number;
  winRate: number; avgReturn: number; avgWin: number; avgLoss: number;
  profitFactor: number; maxDrawdown: number;
  finalCapital: number; totalReturn: number;
  avgHoldDays: number; maxConsecutiveLoss: number;
  sharpe: number;
}

function calcStats(name: string, trades: Trade[]): Stats {
  const wins = trades.filter(t => t.netReturn > 0);
  const losses = trades.filter(t => t.netReturn <= 0);
  const totalProfit = wins.reduce((s, t) => s + t.netReturn, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturn, 0));

  let capital = INITIAL_CAPITAL, peak = INITIAL_CAPITAL, maxDD = 0;
  const returns: number[] = [];
  for (const t of trades) {
    returns.push(t.netReturn);
    capital += Math.round(capital * t.netReturn / 100);
    peak = Math.max(peak, capital);
    maxDD = Math.min(maxDD, (capital - peak) / peak);
  }

  let maxConsLoss = 0, cur = 0;
  for (const t of trades) {
    if (t.netReturn <= 0) { cur++; maxConsLoss = Math.max(maxConsLoss, cur); } else cur = 0;
  }

  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdRet = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + (r - avgRet) ** 2, 0) / (returns.length - 1)) : 1;

  return {
    name, trades,
    totalTrades: trades.length,
    wins: wins.length, losses: losses.length,
    winRate: trades.length > 0 ? +(wins.length / trades.length * 100).toFixed(1) : 0,
    avgReturn: +avgRet.toFixed(2),
    avgWin: wins.length > 0 ? +(totalProfit / wins.length).toFixed(2) : 0,
    avgLoss: losses.length > 0 ? +(-totalLoss / losses.length).toFixed(2) : 0,
    profitFactor: totalLoss > 0 ? +(totalProfit / totalLoss).toFixed(2) : totalProfit > 0 ? 999 : 0,
    maxDrawdown: +(maxDD * 100).toFixed(1),
    finalCapital: capital,
    totalReturn: +((capital / INITIAL_CAPITAL - 1) * 100).toFixed(1),
    avgHoldDays: trades.length > 0 ? +(trades.reduce((s, t) => s + t.holdDays, 0) / trades.length).toFixed(1) : 0,
    maxConsecutiveLoss: maxConsLoss,
    sharpe: stdRet > 0 ? +(avgRet / stdRet).toFixed(3) : 0,
  };
}

function printResults(results: Stats[]) {
  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log('  台股策略回測 Round 3 — 網上經驗證的量化策略');
  console.log(`  期間: ${BACKTEST_START} ~ ${BACKTEST_END} | 初始: ${INITIAL_CAPITAL.toLocaleString()} | 一次一檔`);
  console.log('══════════════════════════════════════════════════════════════════════════════\n');

  const header = '指標'.padEnd(16) + results.map(r => r.name.padStart(10)).join('');
  console.log(header);
  console.log('─'.repeat(16 + results.length * 10));

  const rows: [string, (s: Stats) => string][] = [
    ['總交易數',      s => s.totalTrades.toString()],
    ['勝/負',         s => `${s.wins}/${s.losses}`],
    ['勝率',          s => `${s.winRate}%`],
    ['平均報酬',      s => `${s.avgReturn >= 0 ? '+' : ''}${s.avgReturn}%`],
    ['平均獲利',      s => `+${s.avgWin}%`],
    ['平均虧損',      s => `${s.avgLoss}%`],
    ['盈虧比',        s => s.avgLoss !== 0 ? (s.avgWin / Math.abs(s.avgLoss)).toFixed(2) : 'N/A'],
    ['PF',            s => s.profitFactor.toString()],
    ['Sharpe',        s => s.sharpe.toString()],
    ['最大回撤',      s => `${s.maxDrawdown}%`],
    ['最大連虧',      s => `${s.maxConsecutiveLoss}次`],
    ['持有天數',      s => `${s.avgHoldDays}天`],
    ['最終資金',      s => (s.finalCapital / 10000).toFixed(0) + '萬'],
    ['總報酬',        s => `${s.totalReturn >= 0 ? '+' : ''}${s.totalReturn}%`],
  ];

  for (const [label, fn] of rows) {
    console.log(label.padEnd(16) + results.map(r => fn(r).padStart(10)).join(''));
  }
  console.log('─'.repeat(16 + results.length * 10));

  // 出場原因
  for (const r of results) {
    console.log(`\n  [${r.name}] 出場:`);
    const rc: Record<string, number> = {};
    for (const t of r.trades) rc[t.exitReason] = (rc[t.exitReason] || 0) + 1;
    for (const [reason, count] of Object.entries(rc).sort((a, b) => b[1] - a[1]))
      console.log(`    ${reason.padEnd(14)} ${count}筆 (${(count / r.trades.length * 100).toFixed(0)}%)`);
  }

  // 排名
  console.log('\n\n★ Round 3 策略排名 (依 Profit Factor):');
  const ranked = [...results].sort((a, b) => b.profitFactor - a.profitFactor);
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const mark = r.profitFactor >= 1.3 ? '+++' : r.profitFactor >= 1.0 ? ' + ' : ' - ';
    console.log(`  ${i + 1}. [${mark}] ${r.name.padEnd(10)} PF=${r.profitFactor.toString().padEnd(5)} WR=${r.winRate}% Ret=${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}% Sharpe=${r.sharpe}`);
  }

  // 三輪總排名
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('  三輪總排名 (含 Round 1 V反轉 PF=1.38 / 雙均線 PF=1.36)');
  console.log('═══════════════════════════════════════════════════════════════');

  interface Summary { name: string; pf: number; wr: number; ret: number; sharpe: number; round: string }
  const all: Summary[] = [
    // Round 1 baseline
    { name: 'V型反轉', pf: 1.38, wr: 52.5, ret: 63.3, sharpe: 0.15, round: 'R1' },
    { name: '雙均線趨勢', pf: 1.36, wr: 29.8, ret: 51.8, sharpe: 0.10, round: 'R1' },
    // Round 3
    ...results.map(r => ({ name: r.name, pf: r.profitFactor, wr: r.winRate, ret: r.totalReturn, sharpe: r.sharpe, round: 'R3' })),
  ];
  all.sort((a, b) => b.pf - a.pf);

  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    const mark = a.pf >= 1.3 ? '***' : a.pf >= 1.0 ? ' * ' : '   ';
    console.log(`  ${(i + 1).toString().padStart(2)}. [${mark}] ${a.name.padEnd(10)} PF=${a.pf.toString().padEnd(5)} WR=${a.wr}% Ret=${a.ret >= 0 ? '+' : ''}${a.ret}% Sharpe=${a.sharpe} (${a.round})`);
  }
}

// ══════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log('載入台股數據 + 計算額外指標...');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

  const allStocks = new Map<string, { name: string; candles: R3Candle[] }>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: Candle[] }>)) {
    if (!data.candles || data.candles.length < 60) continue;
    try {
      const base = computeIndicators(data.candles);
      allStocks.set(sym, { name: data.name, candles: enrichCandles(base) });
    } catch { /* skip */ }
  }
  console.log(`  ${allStocks.size} 支股票`);

  const benchSymbol = allStocks.has('2330.TW') ? '2330.TW' : allStocks.keys().next().value;
  const tradingDays = allStocks.get(benchSymbol!)!.candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
  console.log(`  ${tradingDays.length} 交易日\n`);

  const strategies: { name: string; scan: (c: R3Candle[], i: number) => boolean; exit: (c: R3Candle[], e: number, p: number, s: number) => ReturnType<typeof exitRSI2> }[] = [
    { name: 'RSI(2)', scan: scanRSI2, exit: exitRSI2 },
    { name: 'IBS', scan: scanIBS, exit: exitIBS },
    { name: '3日高低', scan: scan3DayHighLow, exit: exit3DayHighLow },
    { name: 'RSI(60)', scan: scanRSI60, exit: exitRSI60 },
    { name: '52週新高', scan: scan52WeekHigh, exit: exit52WeekHigh },
  ];

  const results: Stats[] = [];

  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    console.log(`  [${i + 1}/6] ${s.name}...`);
    const trades = runBacktest(s.name, allStocks, tradingDays, s.scan, s.exit);
    console.log(`    → ${trades.length} 筆`);
    results.push(calcStats(s.name, trades));
  }

  // 缺口回填（特殊T+0回測）
  console.log('  [6/6] 缺口回填...');
  const gapTrades = runGapBacktest(allStocks, tradingDays);
  console.log(`    → ${gapTrades.length} 筆`);
  results.push(calcStats('缺口回填', gapTrades));

  printResults(results);

  // 最佳交易
  console.log('\n\n各策略最佳3筆:');
  for (const r of results) {
    console.log(`  [${r.name}]`);
    for (const t of [...r.trades].sort((a, b) => b.netReturn - a.netReturn).slice(0, 3)) {
      console.log(`    ${t.entryDate} ${t.symbol.padEnd(10)} ${t.name.slice(0, 6).padEnd(8)} ${t.netReturn >= 0 ? '+' : ''}${t.netReturn.toFixed(1)}% (${t.holdDays}天, ${t.exitReason})`);
    }
  }
}

main().catch(console.error);
