/**
 * 台股4策略回測比較
 *
 * 策略1: 聰明K線法 — close > 前日高 → 買；close < 前日低 → 賣
 * 策略2: 雙均線趨勢 — MA10+MA24 黃金排列 + 穿越MA10
 * 策略3: 盤整突破 — BB擠壓 + MA糾結 + 爆量突破20日高
 * 策略4: V型反轉 — 連跌3天+ + 偏離MA20≥12% + 反轉K棒
 *
 * Usage: npx tsx scripts/backtest-tw-4strategies.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

// ── 全域參數 ──────────────────────────────────────────────────
const BACKTEST_START = '2023-07-01';
const BACKTEST_END   = '2026-03-31';
const INITIAL_CAPITAL = 1000000;
const ROUND_TRIP_COST = 0.44; // 台股：手續費0.1425%×2 + 證交稅0.3% ≈ 0.585%（打6折≈0.44%）

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles.json');

// ── Types ─────────────────────────────────────────────────────
interface Trade {
  strategy: string;
  entryDate: string;
  exitDate: string;
  symbol: string;
  name: string;
  entryPrice: number;
  exitPrice: number;
  grossReturn: number;
  netReturn: number;
  holdDays: number;
  exitReason: string;
}

interface StrategyStats {
  name: string;
  trades: Trade[];
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturn: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  finalCapital: number;
  totalReturn: number;
  avgHoldDays: number;
  maxConsecutiveLoss: number;
}

// ── 掃描函數 ──────────────────────────────────────────────────

/**
 * 策略1: 聰明K線法
 * 進場: close > 前日 high + close > MA20 + volume >= avgVol5
 */
function scanSmartKLine(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 1) return false;
  const today = candles[idx];
  const yesterday = candles[idx - 1];

  if (today.ma20 == null || today.avgVol5 == null) return false;

  // 核心: 收盤突破前日最高價
  if (today.close <= yesterday.high) return false;

  // 趨勢過濾: 在MA20上方
  if (today.close <= today.ma20) return false;

  // 量能: 至少平均量
  if (today.volume < today.avgVol5) return false;

  // 收在K棒上半部（確認強勢）
  const range = today.high - today.low;
  if (range > 0 && (today.close - today.low) / range < 0.5) return false;

  // 紅K（收盤 > 開盤）
  if (today.close <= today.open) return false;

  return true;
}

/**
 * 策略1 出場邏輯
 * close < 前日 low → 賣 | 停損-5% | 停利+7% | 持有5天
 */
function exitSmartKLine(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  const maxHold = 5;

  for (let d = 1; d <= maxHold; d++) {
    const futureIdx = entryIdx + d;
    if (futureIdx >= candles.length) return null;

    const c = candles[futureIdx];
    const prev = candles[futureIdx - 1];
    const highRet = (c.high - entryPrice) / entryPrice;
    const lowRet = (c.low - entryPrice) / entryPrice;

    // 停利 +7%
    if (highRet >= 0.07) {
      return { exitIdx: futureIdx, exitPrice: +(entryPrice * 1.07).toFixed(2), exitReason: '停利+7%' };
    }

    // 停損 -5%
    if (lowRet <= -0.05) {
      return { exitIdx: futureIdx, exitPrice: +(entryPrice * 0.95).toFixed(2), exitReason: '停損-5%' };
    }

    // 聰明K線核心: 收盤破前日最低價
    if (c.close < prev.low) {
      return { exitIdx: futureIdx, exitPrice: c.close, exitReason: '破前日低' };
    }

    // 時間到
    if (d === maxHold) {
      return { exitIdx: futureIdx, exitPrice: c.close, exitReason: '持有5天' };
    }
  }
  return null;
}

/**
 * 策略2: 雙均線趨勢 (MA10 + MA24)
 * 進場: MA24上升 + close > MA10 > MA24 + 從MA10下方穿越上方
 */
function scanTwoMA(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 5) return false;
  const today = candles[idx];
  const yesterday = candles[idx - 1];
  const fiveDaysAgo = candles[idx - 5];

  if (today.ma10 == null || today.ma24 == null) return false;
  if (yesterday.ma10 == null || yesterday.ma24 == null) return false;
  if (fiveDaysAgo.ma24 == null) return false;

  // MA24 上升（5日比較）
  if (today.ma24 <= fiveDaysAgo.ma24) return false;

  // 黃金排列: close > MA10 > MA24
  if (today.close <= today.ma10) return false;
  if (today.ma10 <= today.ma24) return false;

  // 穿越: 昨日 close <= MA10，今日 close > MA10
  if (yesterday.close > yesterday.ma10) return false;

  // 紅K確認
  if (today.close <= today.open) return false;

  return true;
}

/**
 * 策略2 出場邏輯
 * close < MA10 → 賣 | MA24 轉下 → 賣 | 停損-7% | 最多持有20天
 */
function exitTwoMA(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  const maxHold = 20;

  for (let d = 1; d <= maxHold; d++) {
    const futureIdx = entryIdx + d;
    if (futureIdx >= candles.length) return null;

    const c = candles[futureIdx];
    const lowRet = (c.low - entryPrice) / entryPrice;

    // 停損 -7%
    if (lowRet <= -0.07) {
      return { exitIdx: futureIdx, exitPrice: +(entryPrice * 0.93).toFixed(2), exitReason: '停損-7%' };
    }

    // 跌破 MA10
    if (c.ma10 != null && c.close < c.ma10) {
      return { exitIdx: futureIdx, exitPrice: c.close, exitReason: '破MA10' };
    }

    // MA24 轉下（比5天前低）
    if (d >= 5 && c.ma24 != null) {
      const prev5 = candles[futureIdx - 5];
      if (prev5.ma24 != null && c.ma24 < prev5.ma24) {
        return { exitIdx: futureIdx, exitPrice: c.close, exitReason: 'MA24轉下' };
      }
    }

    if (d === maxHold) {
      return { exitIdx: futureIdx, exitPrice: c.close, exitReason: '持有20天' };
    }
  }
  return null;
}

/**
 * 策略3: 盤整突破
 * 進場: 20日低波動(bbBandwidth底部) + MA糾結 + 爆量突破20日高
 */
function scanConsolidationBreakout(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 25) return false;
  const today = candles[idx];

  if (today.bbBandwidth == null || today.ma5 == null || today.ma10 == null ||
      today.ma20 == null || today.avgVol20 == null) return false;

  // BB帶寬在近60日的底部25%
  let bwMin = Infinity, bwMax = -Infinity;
  const lookback = Math.min(60, idx);
  for (let i = idx - lookback; i < idx; i++) {
    const bw = candles[i].bbBandwidth;
    if (bw != null) {
      bwMin = Math.min(bwMin, bw);
      bwMax = Math.max(bwMax, bw);
    }
  }
  const bwRange = bwMax - bwMin;
  if (bwRange === 0) return false;
  const bwPercentile = (today.bbBandwidth - bwMin) / bwRange;
  if (bwPercentile > 0.25) return false;

  // MA糾結: MA5和MA10差距<1.5%，MA10和MA20差距<2%
  const ma5_10_diff = Math.abs(today.ma5 - today.ma10) / today.ma10;
  const ma10_20_diff = Math.abs(today.ma10 - today.ma20) / today.ma20;
  if (ma5_10_diff > 0.015 || ma10_20_diff > 0.02) return false;

  // 突破: 收盤 > 20日最高價
  let high20 = -Infinity;
  for (let i = idx - 20; i < idx; i++) {
    high20 = Math.max(high20, candles[i].high);
  }
  if (today.close <= high20) return false;

  // 爆量: volume > 20日均量 × 2
  if (today.volume < today.avgVol20 * 2) return false;

  // 紅K + 實體>50%
  if (today.close <= today.open) return false;
  const range = today.high - today.low;
  if (range > 0 && (today.close - today.open) / range < 0.5) return false;

  // 安全: 不在60日高點附近的突破（要底部/中段突破）
  let high60 = -Infinity;
  for (let i = Math.max(0, idx - 60); i < idx - 20; i++) {
    high60 = Math.max(high60, candles[i].high);
  }
  // 如果20日前的60日高點比現在高很多，說明是下跌後盤整突破（好的）
  // 如果20日前沒有更高的高點，可能是頂部突破（風險高）
  // 放寬：只排除已經在歷史高點附近的突破
  if (high60 < today.close * 0.9) {
    // 60日前的高點比現在低超過10%，可能是新高突破，有風險但允許
  }

  return true;
}

/**
 * 策略3 出場邏輯
 * 停損-5% | 停利+10% | 跌破MA5 | 持有10天
 */
function exitConsolidationBreakout(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  const maxHold = 10;

  for (let d = 1; d <= maxHold; d++) {
    const futureIdx = entryIdx + d;
    if (futureIdx >= candles.length) return null;

    const c = candles[futureIdx];
    const highRet = (c.high - entryPrice) / entryPrice;
    const lowRet = (c.low - entryPrice) / entryPrice;

    // 停利 +10%
    if (highRet >= 0.10) {
      return { exitIdx: futureIdx, exitPrice: +(entryPrice * 1.10).toFixed(2), exitReason: '停利+10%' };
    }

    // 停損 -5%
    if (lowRet <= -0.05) {
      return { exitIdx: futureIdx, exitPrice: +(entryPrice * 0.95).toFixed(2), exitReason: '停損-5%' };
    }

    // 跌破 MA5（持有3天後才啟動，避免太早被洗出去）
    if (d >= 3 && c.ma5 != null && c.close < c.ma5) {
      return { exitIdx: futureIdx, exitPrice: c.close, exitReason: '破MA5' };
    }

    if (d === maxHold) {
      return { exitIdx: futureIdx, exitPrice: c.close, exitReason: '持有10天' };
    }
  }
  return null;
}

/**
 * 策略4: V型反轉
 * 進場: 連跌3天+ + 偏離MA20≥12% + 反轉K棒 + 放量
 */
function scanVReversal(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 5) return false;
  const today = candles[idx];

  if (today.ma20 == null || today.avgVol5 == null) return false;

  // 連跌天數: 至少連跌3天
  let consecutiveDown = 0;
  for (let i = idx - 1; i >= Math.max(0, idx - 10); i--) {
    if (candles[i].close < candles[i].open) {
      consecutiveDown++;
    } else {
      break;
    }
  }
  if (consecutiveDown < 3) return false;

  // 偏離MA20 ≥ 12%
  const deviation = (today.close - today.ma20) / today.ma20;
  if (deviation > -0.12) return false;

  // 反轉K棒: 收在K棒上半部（長下影線/鎚子/吞噬）
  const range = today.high - today.low;
  if (range <= 0) return false;
  const closePosition = (today.close - today.low) / range;
  if (closePosition < 0.4) return false;

  // 放量: volume >= avgVol5 × 1.2
  if (today.volume < today.avgVol5 * 1.2) return false;

  // 安全: MA20在20天前是上升或持平的（原本是多頭，不是長期空頭）
  if (idx >= 20) {
    const ma20_20ago = candles[idx - 20].ma20;
    const ma20_40ago = idx >= 40 ? candles[idx - 40].ma20 : null;
    if (ma20_20ago != null && ma20_40ago != null && ma20_20ago < ma20_40ago) {
      return false; // 長期下跌中，不適合搶反彈
    }
  }

  return true;
}

/**
 * 策略4 出場邏輯
 * 目標=回到跌前高點 | 停損-7% | 持有5天
 */
function exitVReversal(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
  signalIdx: number,
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  const maxHold = 5;

  // 找跌前高點（連跌開始前的最高收盤價）
  let preDropHigh = entryPrice;
  for (let i = signalIdx; i >= Math.max(0, signalIdx - 15); i--) {
    if (candles[i].close > preDropHigh) {
      preDropHigh = candles[i].close;
    }
  }
  const targetReturn = (preDropHigh - entryPrice) / entryPrice;

  for (let d = 1; d <= maxHold; d++) {
    const futureIdx = entryIdx + d;
    if (futureIdx >= candles.length) return null;

    const c = candles[futureIdx];
    const highRet = (c.high - entryPrice) / entryPrice;
    const lowRet = (c.low - entryPrice) / entryPrice;

    // 目標價: 跌前高點（或至少+10%）
    const effectiveTarget = Math.min(targetReturn, 0.15);
    if (effectiveTarget > 0.03 && highRet >= effectiveTarget) {
      return { exitIdx: futureIdx, exitPrice: +(entryPrice * (1 + effectiveTarget)).toFixed(2), exitReason: '達目標價' };
    }

    // 停損 -7%
    if (lowRet <= -0.07) {
      return { exitIdx: futureIdx, exitPrice: +(entryPrice * 0.93).toFixed(2), exitReason: '停損-7%' };
    }

    if (d === maxHold) {
      return { exitIdx: futureIdx, exitPrice: c.close, exitReason: '持有5天' };
    }
  }
  return null;
}

// ── 回測引擎 ──────────────────────────────────────────────────

function runStrategyBacktest(
  strategyName: string,
  allStocks: Map<string, { name: string; candles: CandleWithIndicators[] }>,
  tradingDays: string[],
  scanFn: (candles: CandleWithIndicators[], idx: number) => boolean,
  exitFn: (candles: CandleWithIndicators[], entryIdx: number, entryPrice: number, signalIdx: number) => { exitIdx: number; exitPrice: number; exitReason: string } | null,
): Trade[] {
  const trades: Trade[] = [];
  let holdingUntilDay = -1;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date = tradingDays[dayIdx];
    if (dayIdx <= holdingUntilDay) continue;

    // 掃描所有股票
    interface Candidate {
      symbol: string; name: string;
      candles: CandleWithIndicators[];
      signalIdx: number;
      score: number;
    }
    const candidates: Candidate[] = [];

    for (const [symbol, stockData] of allStocks) {
      const { candles } = stockData;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 25 || idx >= candles.length - 20) continue;

      if (!scanFn(candles, idx)) continue;

      // 排序分數: 量能 + K棒實體
      const c = candles[idx];
      const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
      const volRatio = c.avgVol5 && c.avgVol5 > 0 ? c.volume / c.avgVol5 : 1;
      const score = bodyPct * volRatio;

      candidates.push({
        symbol, name: stockData.name,
        candles, signalIdx: idx, score,
      });
    }

    if (candidates.length === 0) continue;

    // 選最強的一檔
    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[0];

    // 隔日開盤進場
    const entryIdx = pick.signalIdx + 1;
    if (entryIdx >= pick.candles.length) continue;
    const entryPrice = pick.candles[entryIdx].open;
    const entryDate = pick.candles[entryIdx].date?.slice(0, 10) ?? '';

    // 出場
    const exit = exitFn(pick.candles, entryIdx, entryPrice, pick.signalIdx);
    if (!exit) continue;

    const grossReturn = +((exit.exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
    const netReturn = +(grossReturn - ROUND_TRIP_COST).toFixed(2);
    const holdDays = exit.exitIdx - entryIdx;

    const exitDate = pick.candles[exit.exitIdx]?.date?.slice(0, 10) ?? '';
    const exitDayIdx = tradingDays.indexOf(exitDate);
    holdingUntilDay = exitDayIdx >= 0 ? exitDayIdx : dayIdx + holdDays;

    trades.push({
      strategy: strategyName,
      entryDate, exitDate,
      symbol: pick.symbol, name: pick.name,
      entryPrice, exitPrice: exit.exitPrice,
      grossReturn, netReturn, holdDays,
      exitReason: exit.exitReason,
    });
  }

  return trades;
}

// ── 統計計算 ──────────────────────────────────────────────────

function calcStats(name: string, trades: Trade[]): StrategyStats {
  const wins = trades.filter(t => t.netReturn > 0);
  const losses = trades.filter(t => t.netReturn <= 0);

  const totalProfit = wins.reduce((s, t) => s + t.netReturn, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturn, 0));

  // 最大回撤（累計資金曲線）
  let capital = INITIAL_CAPITAL;
  let peak = capital;
  let maxDD = 0;
  for (const t of trades) {
    capital += Math.round(capital * t.netReturn / 100);
    peak = Math.max(peak, capital);
    const dd = (capital - peak) / peak;
    maxDD = Math.min(maxDD, dd);
  }

  // 最大連續虧損
  let maxConsLoss = 0, curConsLoss = 0;
  for (const t of trades) {
    if (t.netReturn <= 0) {
      curConsLoss++;
      maxConsLoss = Math.max(maxConsLoss, curConsLoss);
    } else {
      curConsLoss = 0;
    }
  }

  return {
    name,
    trades,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? +(wins.length / trades.length * 100).toFixed(1) : 0,
    avgReturn: trades.length > 0 ? +(trades.reduce((s, t) => s + t.netReturn, 0) / trades.length).toFixed(2) : 0,
    avgWin: wins.length > 0 ? +(totalProfit / wins.length).toFixed(2) : 0,
    avgLoss: losses.length > 0 ? +(-totalLoss / losses.length).toFixed(2) : 0,
    profitFactor: totalLoss > 0 ? +(totalProfit / totalLoss).toFixed(2) : totalProfit > 0 ? 999 : 0,
    maxDrawdown: +(maxDD * 100).toFixed(1),
    finalCapital: capital,
    totalReturn: +((capital / INITIAL_CAPITAL - 1) * 100).toFixed(1),
    avgHoldDays: trades.length > 0 ? +(trades.reduce((s, t) => s + t.holdDays, 0) / trades.length).toFixed(1) : 0,
    maxConsecutiveLoss: maxConsLoss,
  };
}

// ── 輸出 ──────────────────────────────────────────────────────

function printComparison(results: StrategyStats[]) {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  台股4策略回測比較');
  console.log(`  期間：${BACKTEST_START} ~ ${BACKTEST_END}`);
  console.log(`  初始資金：${INITIAL_CAPITAL.toLocaleString()} | 一次只買一檔 | 隔日開盤進場`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const header = '指標'.padEnd(16) + results.map(r => r.name.padStart(12)).join('');
  console.log(header);
  console.log('─'.repeat(16 + results.length * 12));

  const rows: [string, (s: StrategyStats) => string][] = [
    ['總交易數',      s => s.totalTrades.toString()],
    ['勝/負',         s => `${s.wins}/${s.losses}`],
    ['勝率',          s => `${s.winRate}%`],
    ['平均報酬',      s => `${s.avgReturn >= 0 ? '+' : ''}${s.avgReturn}%`],
    ['平均獲利',      s => `+${s.avgWin}%`],
    ['平均虧損',      s => `${s.avgLoss}%`],
    ['盈虧比',        s => s.avgLoss !== 0 ? (s.avgWin / Math.abs(s.avgLoss)).toFixed(2) : 'N/A'],
    ['Profit Factor', s => s.profitFactor.toString()],
    ['最大回撤',      s => `${s.maxDrawdown}%`],
    ['最大連虧',      s => `${s.maxConsecutiveLoss}次`],
    ['平均持有',      s => `${s.avgHoldDays}天`],
    ['最終資金',      s => s.finalCapital.toLocaleString()],
    ['總報酬',        s => `${s.totalReturn >= 0 ? '+' : ''}${s.totalReturn}%`],
  ];

  for (const [label, fn] of rows) {
    const row = label.padEnd(16) + results.map(r => fn(r).padStart(12)).join('');
    console.log(row);
  }

  console.log('─'.repeat(16 + results.length * 12));

  // 每個策略的出場原因分佈
  for (const r of results) {
    console.log(`\n  [${r.name}] 出場原因:`);
    const rc: Record<string, number> = {};
    for (const t of r.trades) rc[t.exitReason] = (rc[t.exitReason] || 0) + 1;
    for (const [reason, count] of Object.entries(rc).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason.padEnd(14)} ${count}筆 (${(count / r.trades.length * 100).toFixed(0)}%)`);
    }
  }

  // 月度分析
  console.log('\n\n月度報酬 (%)');
  console.log('─'.repeat(16 + results.length * 12));
  console.log('月份'.padEnd(16) + results.map(r => r.name.padStart(12)).join(''));

  const months = new Set<string>();
  for (const r of results) {
    for (const t of r.trades) months.add(t.exitDate.slice(0, 7));
  }
  const sortedMonths = [...months].sort();

  for (const month of sortedMonths) {
    const row = month.padEnd(16) + results.map(r => {
      const monthTrades = r.trades.filter(t => t.exitDate.startsWith(month));
      if (monthTrades.length === 0) return '-'.padStart(12);
      const ret = monthTrades.reduce((s, t) => s + t.netReturn, 0);
      return `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}`.padStart(12);
    }).join('');
    console.log(row);
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('載入台股數據...');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

  const allStocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: any[] }>)) {
    if (!data.candles || data.candles.length < 60) continue;
    try {
      allStocks.set(sym, { name: data.name, candles: computeIndicators(data.candles) });
    } catch { /* skip broken data */ }
  }
  console.log(`  ${allStocks.size} 支股票載入完成`);

  // 取交易日序列
  const benchSymbol = allStocks.has('2330.TW') ? '2330.TW' : allStocks.keys().next().value;
  const benchCandles = allStocks.get(benchSymbol!)!.candles;
  const tradingDays = benchCandles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
  console.log(`  ${tradingDays.length} 個交易日 (${BACKTEST_START} ~ ${BACKTEST_END})\n`);

  // 跑4個策略
  console.log('回測中...');

  console.log('  [1/4] 聰明K線法...');
  const smartKTrades = runStrategyBacktest('聰明K線', allStocks, tradingDays, scanSmartKLine, exitSmartKLine);
  console.log(`    → ${smartKTrades.length} 筆交易`);

  console.log('  [2/4] 雙均線趨勢...');
  const twoMATrades = runStrategyBacktest('雙均線', allStocks, tradingDays, scanTwoMA, exitTwoMA);
  console.log(`    → ${twoMATrades.length} 筆交易`);

  console.log('  [3/4] 盤整突破...');
  const breakoutTrades = runStrategyBacktest('盤整突破', allStocks, tradingDays, scanConsolidationBreakout, exitConsolidationBreakout);
  console.log(`    → ${breakoutTrades.length} 筆交易`);

  console.log('  [4/4] V型反轉...');
  const vReversalTrades = runStrategyBacktest('V反轉', allStocks, tradingDays, scanVReversal, (candles, entryIdx, entryPrice, signalIdx) => exitVReversal(candles, entryIdx, entryPrice, signalIdx));
  console.log(`    → ${vReversalTrades.length} 筆交易`);

  // 統計
  const results = [
    calcStats('聰明K線', smartKTrades),
    calcStats('雙均線', twoMATrades),
    calcStats('盤整突破', breakoutTrades),
    calcStats('V反轉', vReversalTrades),
  ];

  printComparison(results);

  // 輸出最佳交易（每策略前5）
  console.log('\n\n各策略最佳5筆交易:');
  for (const r of results) {
    console.log(`\n  [${r.name}]`);
    const best = [...r.trades].sort((a, b) => b.netReturn - a.netReturn).slice(0, 5);
    for (const t of best) {
      console.log(`    ${t.entryDate} ${t.symbol.padEnd(10)} ${t.name.slice(0, 6).padEnd(8)} +${t.netReturn.toFixed(1)}% (${t.holdDays}天, ${t.exitReason})`);
    }
  }

  // 輸出最差交易（每策略前5）
  console.log('\n各策略最差5筆交易:');
  for (const r of results) {
    console.log(`\n  [${r.name}]`);
    const worst = [...r.trades].sort((a, b) => a.netReturn - b.netReturn).slice(0, 5);
    for (const t of worst) {
      console.log(`    ${t.entryDate} ${t.symbol.padEnd(10)} ${t.name.slice(0, 6).padEnd(8)} ${t.netReturn.toFixed(1)}% (${t.holdDays}天, ${t.exitReason})`);
    }
  }
}

main().catch(console.error);
