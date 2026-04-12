/**
 * 打板排序優化回測
 *
 * 測試 4 種改進方向：
 * 1. 複合排序（成交額 × 低股價加權）
 * 2. 提高高開門檻（≥3%, ≥4%）
 * 3. 只買首板（排除連板）
 * 4. 組合方案
 *
 * Usage: npx tsx scripts/backtest-cn-daban-optimize.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const BACKTEST_START = '2025-04-01';
const BACKTEST_END   = '2026-04-04';
const INITIAL_CAPITAL = 1000000;

const LIMIT_UP_PCT     = 9.5;
const MIN_TURNOVER     = 5e6;
const TAKE_PROFIT_PCT  = 5;
const STOP_LOSS_PCT    = -3;
const MAX_HOLD_DAYS    = 2;
const ROUND_TRIP_COST  = 0.16;

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');

interface Trade {
  entryDate: string; exitDate: string;
  symbol: string; name: string;
  entryPrice: number; exitPrice: number;
  netReturn: number; holdDays: number;
  exitReason: string;
  consecutiveLimits: number;
}

interface Candidate {
  symbol: string; name: string; idx: number;
  candles: CandleWithIndicators[];
  entryPrice: number;
  prevDayGain: number; gapUpPct: number;
  consecutiveLimits: number;
  turnover: number;
  price: number;       // 收盤價
  volumeRatio: number; // 量比
}

interface Strategy {
  name: string;
  gapUpMin: number;
  firstBoardOnly: boolean;
  rankFn: (c: Candidate) => number;
}

function getDayReturn(candles: CandleWithIndicators[], idx: number): number {
  if (idx <= 0) return 0;
  return (candles[idx].close - candles[idx - 1].close) / candles[idx - 1].close * 100;
}

function getConsecutiveLimitUp(candles: CandleWithIndicators[], idx: number): number {
  let count = 0;
  for (let i = idx; i >= 1; i--) {
    if (getDayReturn(candles, i) >= LIMIT_UP_PCT) count++;
    else break;
  }
  return count;
}

function getVolumeRatio(candles: CandleWithIndicators[], idx: number): number {
  if (idx < 5) return 1;
  let sum = 0;
  for (let i = idx - 5; i < idx; i++) sum += candles[i].volume;
  const avg5 = sum / 5;
  return avg5 > 0 ? candles[idx].volume / avg5 : 1;
}

function simulateTrade(pick: Candidate): Trade | null {
  const candles = pick.candles;
  const entryIdx = pick.idx;
  let exitIdx = entryIdx;
  let exitPrice = pick.entryPrice;
  let exitReason = '';

  for (let d = 1; d <= MAX_HOLD_DAYS; d++) {
    const futureIdx = entryIdx + d;
    if (futureIdx >= candles.length) break;
    const c = candles[futureIdx];
    const highReturn = (c.high - pick.entryPrice) / pick.entryPrice * 100;
    const lowReturn = (c.low - pick.entryPrice) / pick.entryPrice * 100;

    if (highReturn >= TAKE_PROFIT_PCT) {
      exitIdx = futureIdx;
      exitPrice = +(pick.entryPrice * (1 + TAKE_PROFIT_PCT / 100)).toFixed(2);
      exitReason = '止盈+5%';
      break;
    }
    if (lowReturn <= STOP_LOSS_PCT) {
      exitIdx = futureIdx;
      exitPrice = +(pick.entryPrice * (1 + STOP_LOSS_PCT / 100)).toFixed(2);
      exitReason = '止損-3%';
      break;
    }
    if (d === MAX_HOLD_DAYS) {
      exitIdx = futureIdx;
      exitPrice = c.close;
      exitReason = '持有2天';
      break;
    }
    if (d === 1 && c.close < c.open) {
      const nextIdx = futureIdx + 1;
      if (nextIdx < candles.length) {
        exitIdx = nextIdx;
        exitPrice = candles[nextIdx].open;
        exitReason = '收黑隔日走';
        break;
      }
    }
  }

  if (exitIdx === entryIdx) return null;
  const grossReturn = +((exitPrice - pick.entryPrice) / pick.entryPrice * 100).toFixed(2);
  const netReturn = +(grossReturn - ROUND_TRIP_COST).toFixed(2);
  const exitDate = candles[exitIdx]?.date?.slice(0, 10) ?? '';

  return {
    entryDate: candles[entryIdx].date?.slice(0, 10) ?? '',
    exitDate,
    symbol: pick.symbol, name: pick.name,
    entryPrice: pick.entryPrice, exitPrice,
    netReturn, holdDays: exitIdx - entryIdx,
    exitReason,
    consecutiveLimits: pick.consecutiveLimits,
  };
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const allStocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, any>)) {
    if (!data.candles || data.candles.length < 60) continue;
    if (data.name.includes('ST')) continue;
    try { allStocks.set(sym, { name: data.name, candles: computeIndicators(data.candles) }); } catch {}
  }

  const benchStock = allStocks.get('000001.SZ') ?? allStocks.get('601318.SS');
  if (!benchStock) { console.error('找不到基準'); return; }
  const tradingDays = benchStock.candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);

  console.log(`\n${allStocks.size} 支股票, ${tradingDays.length} 個交易日\n`);

  // ── 定義策略 ──────────────────────────────────────────────────────────
  const strategies: Strategy[] = [
    // 基線：現行排序
    {
      name: '基線：成交額排序 高開≥2%',
      gapUpMin: 2.0,
      firstBoardOnly: false,
      rankFn: (c) => {
        const bb = c.consecutiveLimits === 1 ? 2.0 : c.consecutiveLimits === 2 ? 1.5 : 1.0;
        return bb * Math.log10(c.turnover);
      },
    },
    // ── 改進1：複合排序（成交額 + 低股價加權）──
    {
      name: '複合：成交額×低價加權 高開≥2%',
      gapUpMin: 2.0,
      firstBoardOnly: false,
      rankFn: (c) => {
        const bb = c.consecutiveLimits === 1 ? 2.0 : c.consecutiveLimits === 2 ? 1.5 : 1.0;
        const priceBonus = c.price < 20 ? 1.5 : c.price < 50 ? 1.2 : 1.0;
        return bb * Math.log10(c.turnover) * priceBonus;
      },
    },
    // ── 改進2：提高高開門檻 ──
    {
      name: '基線排序 高開≥3%',
      gapUpMin: 3.0,
      firstBoardOnly: false,
      rankFn: (c) => {
        const bb = c.consecutiveLimits === 1 ? 2.0 : c.consecutiveLimits === 2 ? 1.5 : 1.0;
        return bb * Math.log10(c.turnover);
      },
    },
    {
      name: '基線排序 高開≥4%',
      gapUpMin: 4.0,
      firstBoardOnly: false,
      rankFn: (c) => {
        const bb = c.consecutiveLimits === 1 ? 2.0 : c.consecutiveLimits === 2 ? 1.5 : 1.0;
        return bb * Math.log10(c.turnover);
      },
    },
    // ── 改進3：只買首板 ──
    {
      name: '只買首板 高開≥2%',
      gapUpMin: 2.0,
      firstBoardOnly: true,
      rankFn: (c) => Math.log10(c.turnover),
    },
    {
      name: '只買首板 高開≥3%',
      gapUpMin: 3.0,
      firstBoardOnly: true,
      rankFn: (c) => Math.log10(c.turnover),
    },
    // ── 改進4：複合 + 首板 + 高開 ──
    {
      name: '首板+低價+成交額 高開≥2%',
      gapUpMin: 2.0,
      firstBoardOnly: true,
      rankFn: (c) => {
        const priceBonus = c.price < 20 ? 1.5 : c.price < 50 ? 1.2 : 1.0;
        return Math.log10(c.turnover) * priceBonus;
      },
    },
    {
      name: '首板+低價+成交額 高開≥3%',
      gapUpMin: 3.0,
      firstBoardOnly: true,
      rankFn: (c) => {
        const priceBonus = c.price < 20 ? 1.5 : c.price < 50 ? 1.2 : 1.0;
        return Math.log10(c.turnover) * priceBonus;
      },
    },
    // ── 改進5：量比加權 ──
    {
      name: '成交額×量比 高開≥2%',
      gapUpMin: 2.0,
      firstBoardOnly: false,
      rankFn: (c) => {
        const bb = c.consecutiveLimits === 1 ? 2.0 : c.consecutiveLimits === 2 ? 1.5 : 1.0;
        const volBonus = c.volumeRatio > 2 ? 1.3 : c.volumeRatio > 1.5 ? 1.1 : 1.0;
        return bb * Math.log10(c.turnover) * volBonus;
      },
    },
    // ── 改進6：反向 — 選成交額最小（冷門股）──
    {
      name: '反向：成交額最小 高開≥2%',
      gapUpMin: 2.0,
      firstBoardOnly: false,
      rankFn: (c) => {
        const bb = c.consecutiveLimits === 1 ? 2.0 : c.consecutiveLimits === 2 ? 1.5 : 1.0;
        return bb * (1 / Math.log10(c.turnover));
      },
    },
    // ── 改進7：選 Top-3 平均 vs Top-1 ──
    // (handled separately below)
  ];

  // ── 預先計算每天的候選人 ──────────────────────────────────────────────
  const dailyCandidates = new Map<string, Candidate[]>();

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date = tradingDays[dayIdx];
    const candidates: Candidate[] = [];

    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 5 || idx >= candles.length - MAX_HOLD_DAYS - 1) continue;

      const today = candles[idx];
      const yesterday = candles[idx - 1];
      const dayBefore = candles[idx - 2];

      const prevDayGain = (yesterday.close - dayBefore.close) / dayBefore.close * 100;
      if (prevDayGain < LIMIT_UP_PCT) continue;

      const gapUpPct = (today.open - yesterday.close) / yesterday.close * 100;
      // gapUp threshold applied per strategy

      const turnover = (today.volume ?? 0) * today.close;
      if (turnover < MIN_TURNOVER) continue;

      if (today.open === today.high && today.high === today.close) continue;
      if (today.close < yesterday.close) continue;

      const consecutiveLimits = getConsecutiveLimitUp(candles, idx - 1);
      const volumeRatio = getVolumeRatio(candles, idx);

      candidates.push({
        symbol, name: stockData.name, idx, candles,
        entryPrice: today.open,
        prevDayGain: +prevDayGain.toFixed(2),
        gapUpPct: +gapUpPct.toFixed(2),
        consecutiveLimits,
        turnover,
        price: today.close,
        volumeRatio: +volumeRatio.toFixed(2),
      });
    }

    dailyCandidates.set(date, candidates);
  }

  // ── 跑每個策略 ──────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  打板排序優化回測比較');
  console.log('  期間：' + BACKTEST_START + ' ~ ' + BACKTEST_END);
  console.log('  每日只買排名第1檔，真實資金流');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const results: {
    name: string; trades: number; wins: number; winRate: string;
    totalReturn: string; avgReturn: string; capital: number;
    avgWin: string; avgLoss: string; profitFactor: string;
  }[] = [];

  for (const strat of strategies) {
    const trades: Trade[] = [];
    let holdingUntilIdx = -1;
    let capital = INITIAL_CAPITAL;

    for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
      if (dayIdx <= holdingUntilIdx) continue;
      const date = tradingDays[dayIdx];
      let candidates = dailyCandidates.get(date) ?? [];

      // 過濾高開門檻
      candidates = candidates.filter(c => c.gapUpPct >= strat.gapUpMin);
      // 首板過濾
      if (strat.firstBoardOnly) candidates = candidates.filter(c => c.consecutiveLimits === 1);
      if (candidates.length === 0) continue;

      // 排序
      candidates.sort((a, b) => strat.rankFn(b) - strat.rankFn(a));
      const pick = candidates[0];
      const trade = simulateTrade(pick);
      if (!trade) continue;

      const exitDayIdx = tradingDays.indexOf(trade.exitDate);
      holdingUntilIdx = exitDayIdx >= 0 ? exitDayIdx : dayIdx + trade.holdDays;
      capital += Math.round(capital * trade.netReturn / 100);
      trades.push(trade);
    }

    const wins = trades.filter(t => t.netReturn > 0);
    const losses = trades.filter(t => t.netReturn <= 0);
    const avgWin = wins.length > 0 ? wins.reduce((s,t)=>s+t.netReturn,0)/wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s,t)=>s+t.netReturn,0)/losses.length : 0;
    const totalWin = wins.reduce((s,t) => s + t.netReturn, 0);
    const totalLoss = Math.abs(losses.reduce((s,t) => s + t.netReturn, 0));

    results.push({
      name: strat.name,
      trades: trades.length,
      wins: wins.length,
      winRate: trades.length > 0 ? (wins.length/trades.length*100).toFixed(1) : '0',
      totalReturn: ((capital/INITIAL_CAPITAL-1)*100).toFixed(1),
      avgReturn: trades.length > 0 ? (trades.reduce((s,t)=>s+t.netReturn,0)/trades.length).toFixed(2) : '0',
      capital,
      avgWin: '+' + avgWin.toFixed(2),
      avgLoss: avgLoss.toFixed(2),
      profitFactor: totalLoss > 0 ? (totalWin / totalLoss).toFixed(2) : 'N/A',
    });
  }

  // ── Top-3 平均策略（特殊處理）──
  {
    const trades: Trade[] = [];
    let holdingUntilIdx = -1;
    let capital = INITIAL_CAPITAL;

    for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
      if (dayIdx <= holdingUntilIdx) continue;
      const date = tradingDays[dayIdx];
      let candidates = dailyCandidates.get(date) ?? [];
      candidates = candidates.filter(c => c.gapUpPct >= 2.0);
      if (candidates.length === 0) continue;

      // 基線排序
      candidates.sort((a, b) => {
        const bbA = a.consecutiveLimits === 1 ? 2.0 : a.consecutiveLimits === 2 ? 1.5 : 1.0;
        const bbB = b.consecutiveLimits === 1 ? 2.0 : b.consecutiveLimits === 2 ? 1.5 : 1.0;
        return (bbB * Math.log10(b.turnover)) - (bbA * Math.log10(a.turnover));
      });

      // 取 Top 3，模擬每檔交易取平均（但只買一檔 = 隨機選一檔）
      // 改用：取Top3中回測表現最好的排序位置
      // 實際策略：買 Top-2 而非 Top-1
      const pick = candidates.length >= 2 ? candidates[1] : candidates[0]; // 買第2名
      const trade = simulateTrade(pick);
      if (!trade) continue;

      const exitDayIdx = tradingDays.indexOf(trade.exitDate);
      holdingUntilIdx = exitDayIdx >= 0 ? exitDayIdx : dayIdx + trade.holdDays;
      capital += Math.round(capital * trade.netReturn / 100);
      trades.push(trade);
    }

    const wins = trades.filter(t => t.netReturn > 0);
    const losses = trades.filter(t => t.netReturn <= 0);
    const avgWin = wins.length > 0 ? wins.reduce((s,t)=>s+t.netReturn,0)/wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s,t)=>s+t.netReturn,0)/losses.length : 0;
    const totalWin = wins.reduce((s,t) => s + t.netReturn, 0);
    const totalLoss = Math.abs(losses.reduce((s,t) => s + t.netReturn, 0));

    results.push({
      name: '買第2名（非第1名） 高開≥2%',
      trades: trades.length,
      wins: wins.length,
      winRate: trades.length > 0 ? (wins.length/trades.length*100).toFixed(1) : '0',
      totalReturn: ((capital/INITIAL_CAPITAL-1)*100).toFixed(1),
      avgReturn: trades.length > 0 ? (trades.reduce((s,t)=>s+t.netReturn,0)/trades.length).toFixed(2) : '0',
      capital,
      avgWin: '+' + avgWin.toFixed(2),
      avgLoss: avgLoss.toFixed(2),
      profitFactor: totalLoss > 0 ? (totalWin / totalLoss).toFixed(2) : 'N/A',
    });
  }

  // ── 買第3名 ──
  {
    const trades: Trade[] = [];
    let holdingUntilIdx = -1;
    let capital = INITIAL_CAPITAL;

    for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
      if (dayIdx <= holdingUntilIdx) continue;
      const date = tradingDays[dayIdx];
      let candidates = dailyCandidates.get(date) ?? [];
      candidates = candidates.filter(c => c.gapUpPct >= 2.0);
      if (candidates.length < 3) continue;

      candidates.sort((a, b) => {
        const bbA = a.consecutiveLimits === 1 ? 2.0 : a.consecutiveLimits === 2 ? 1.5 : 1.0;
        const bbB = b.consecutiveLimits === 1 ? 2.0 : b.consecutiveLimits === 2 ? 1.5 : 1.0;
        return (bbB * Math.log10(b.turnover)) - (bbA * Math.log10(a.turnover));
      });

      const pick = candidates[2]; // 買第3名
      const trade = simulateTrade(pick);
      if (!trade) continue;

      const exitDayIdx = tradingDays.indexOf(trade.exitDate);
      holdingUntilIdx = exitDayIdx >= 0 ? exitDayIdx : dayIdx + trade.holdDays;
      capital += Math.round(capital * trade.netReturn / 100);
      trades.push(trade);
    }

    const wins = trades.filter(t => t.netReturn > 0);
    const losses = trades.filter(t => t.netReturn <= 0);
    const avgWin = wins.length > 0 ? wins.reduce((s,t)=>s+t.netReturn,0)/wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s,t)=>s+t.netReturn,0)/losses.length : 0;
    const totalWin = wins.reduce((s,t) => s + t.netReturn, 0);
    const totalLoss = Math.abs(losses.reduce((s,t) => s + t.netReturn, 0));

    results.push({
      name: '買第3名 高開≥2%',
      trades: trades.length,
      wins: wins.length,
      winRate: trades.length > 0 ? (wins.length/trades.length*100).toFixed(1) : '0',
      totalReturn: ((capital/INITIAL_CAPITAL-1)*100).toFixed(1),
      avgReturn: trades.length > 0 ? (trades.reduce((s,t)=>s+t.netReturn,0)/trades.length).toFixed(2) : '0',
      capital,
      avgWin: '+' + avgWin.toFixed(2),
      avgLoss: avgLoss.toFixed(2),
      profitFactor: totalLoss > 0 ? (totalWin / totalLoss).toFixed(2) : 'N/A',
    });
  }

  // ── 輸出比較表 ──────────────────────────────────────────────────────
  console.log('策略'.padEnd(35) + '筆數'.padStart(5) + '  勝率'.padStart(6) + '  均報酬'.padStart(8) + '  總報酬'.padStart(9) + '  最終資金'.padStart(13) + '  均勝'.padStart(7) + '  均負'.padStart(7) + '  盈虧比'.padStart(7));
  console.log('─'.repeat(105));

  // 按總報酬排序
  results.sort((a, b) => parseFloat(b.totalReturn) - parseFloat(a.totalReturn));

  for (const r of results) {
    const marker = r.name.startsWith('基線') ? ' ◀ 現行' : '';
    console.log(
      r.name.padEnd(35) +
      r.trades.toString().padStart(5) + '  ' +
      (r.winRate + '%').padStart(6) + '  ' +
      (r.avgReturn + '%').padStart(8) + '  ' +
      (r.totalReturn + '%').padStart(9) + '  ' +
      r.capital.toLocaleString().padStart(13) + '  ' +
      (r.avgWin + '%').padStart(7) + '  ' +
      (r.avgLoss + '%').padStart(7) + '  ' +
      r.profitFactor.padStart(7) +
      marker
    );
  }
  console.log('─'.repeat(105));

  // ── 最佳策略詳細交易紀錄 ──
  const best = results[0];
  console.log(`\n最佳策略：${best.name}`);
  console.log(`報酬率 ${best.totalReturn}%  勝率 ${best.winRate}%  ${best.trades}筆  盈虧比 ${best.profitFactor}`);
}

main().catch(console.error);
