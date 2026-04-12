/**
 * 台股 Top 2 策略逐筆回測（100萬一次一檔）
 *
 * 1. 52週新高動能 (PF 2.94)
 * 2. 缺口回填 (PF 1.57)
 *
 * 輸出: 每筆交易明細 + 資金曲線 + 月度損益
 *
 * Usage: npx tsx scripts/backtest-tw-top2-detail.ts
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

// ── 額外指標 ──────────────────────────────────────────────────

function computeCustomRSI(closes: number[], period: number): (number | undefined)[] {
  const result: (number | undefined)[] = new Array(closes.length).fill(undefined);
  if (closes.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
  }
  return result;
}

interface R3Candle extends CandleWithIndicators {
  rsi2?: number;
  high252?: number;
}

function enrichCandles(candles: CandleWithIndicators[]): R3Candle[] {
  const closes = candles.map(c => c.close);
  const rsi2arr = computeCustomRSI(closes, 2);
  return candles.map((c, i) => {
    let high252 = c.close;
    for (let j = Math.max(0, i - 252); j < i; j++) high252 = Math.max(high252, candles[j].close);
    return { ...c, rsi2: rsi2arr[i], high252 } as R3Candle;
  });
}

interface Trade {
  num: number;
  entryDate: string; exitDate: string;
  symbol: string; name: string;
  entryPrice: number; exitPrice: number;
  grossReturn: number; netReturn: number;
  holdDays: number; exitReason: string;
  capitalAfter: number;
}

// ══════════════════════════════════════════════════════════════
// 策略1: 52週新高動能
// ══════════════════════════════════════════════════════════════

function run52WeekHigh(
  allStocks: Map<string, { name: string; candles: R3Candle[] }>,
  tradingDays: string[],
): Trade[] {
  const trades: Trade[] = [];
  let holdingUntilDay = -1;
  let capital = INITIAL_CAPITAL;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date = tradingDays[dayIdx];
    if (dayIdx <= holdingUntilDay) continue;

    interface Candidate {
      symbol: string; name: string; candles: R3Candle[];
      idx: number; ratio: number; score: number;
    }
    const candidates: Candidate[] = [];

    for (const [symbol, stockData] of allStocks) {
      const { candles } = stockData;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 252 || idx >= candles.length - 20) continue;

      const c = candles[idx];
      if (c.high252 == null || c.ma20 == null || c.avgVol5 == null) continue;
      if (c.high252 === 0) continue;

      const ratio = c.close / c.high252;
      if (ratio < 0.95 || ratio > 1.05) continue;
      if (c.close <= c.ma20) continue;
      if (c.close <= c.open) continue;
      if (c.volume < c.avgVol5 * 0.8) continue;

      // 排序: 越接近新高 + 量能越大越好
      const volRatio = c.avgVol5 > 0 ? c.volume / c.avgVol5 : 1;
      candidates.push({ symbol, name: stockData.name, candles, idx, ratio, score: ratio * volRatio });
    }

    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[0];

    // 隔日開盤進場
    const entryIdx = pick.idx + 1;
    if (entryIdx >= pick.candles.length) continue;
    const entryPrice = pick.candles[entryIdx].open;
    const entryDate = pick.candles[entryIdx].date?.slice(0, 10) ?? '';

    // 出場
    let exitIdx = entryIdx, exitPrice = entryPrice, exitReason = '';
    for (let d = 1; d <= 20; d++) {
      const fi = entryIdx + d;
      if (fi >= pick.candles.length) break;
      const c = pick.candles[fi];

      if (c.low <= entryPrice * 0.90) {
        exitIdx = fi; exitPrice = +(entryPrice * 0.90).toFixed(2); exitReason = '停損-10%'; break;
      }
      if (c.ma20 != null && c.close < c.ma20) {
        exitIdx = fi; exitPrice = c.close; exitReason = '破MA20'; break;
      }
      if (d === 20) {
        exitIdx = fi; exitPrice = c.close; exitReason = '持有20天'; break;
      }
    }
    if (exitIdx === entryIdx) continue;

    const grossReturn = +((exitPrice - entryPrice) / entryPrice * 100).toFixed(2);
    const netReturn = +(grossReturn - ROUND_TRIP_COST).toFixed(2);
    const holdDays = exitIdx - entryIdx;
    capital += Math.round(capital * netReturn / 100);

    const exitDate = pick.candles[exitIdx]?.date?.slice(0, 10) ?? '';
    const exitDayIdx = tradingDays.indexOf(exitDate);
    holdingUntilDay = exitDayIdx >= 0 ? exitDayIdx : dayIdx + holdDays;

    trades.push({
      num: trades.length + 1,
      entryDate, exitDate,
      symbol: pick.symbol, name: pick.name,
      entryPrice, exitPrice,
      grossReturn, netReturn, holdDays, exitReason,
      capitalAfter: capital,
    });
  }
  return trades;
}

// ══════════════════════════════════════════════════════════════
// 策略2: 缺口回填
// ══════════════════════════════════════════════════════════════

function runGapReversion(
  allStocks: Map<string, { name: string; candles: R3Candle[] }>,
  tradingDays: string[],
): Trade[] {
  const trades: Trade[] = [];
  let capital = INITIAL_CAPITAL;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date = tradingDays[dayIdx];

    interface Candidate {
      symbol: string; name: string; candles: R3Candle[];
      idx: number; gapPct: number;
    }
    const candidates: Candidate[] = [];

    for (const [symbol, stockData] of allStocks) {
      const { candles } = stockData;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 60 || idx >= candles.length) continue;

      const today = candles[idx];
      const yesterday = candles[idx - 1];
      if (yesterday.ma240 == null) continue;

      // 前日趨勢向上
      if (yesterday.close <= yesterday.ma240) continue;

      // 跳空下跌 2%~7%
      const gapPct = (today.open - yesterday.close) / yesterday.close * 100;
      if (gapPct >= -2 || gapPct < -7) continue;

      // RSI(2) 超賣
      if (idx >= 2 && candles[idx - 1].rsi2 != null && candles[idx - 1].rsi2! >= 20) continue;

      candidates.push({ symbol, name: stockData.name, candles, idx, gapPct });
    }

    if (candidates.length === 0) continue;
    // 小缺口優先（回填率更高）
    candidates.sort((a, b) => b.gapPct - a.gapPct);
    const pick = candidates[0];

    const c = pick.candles[pick.idx];
    const entryPrice = c.open;

    // T+0: 當日收盤賣或停損-3%
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
    capital += Math.round(capital * netReturn / 100);

    trades.push({
      num: trades.length + 1,
      entryDate: date, exitDate: date,
      symbol: pick.symbol, name: pick.name,
      entryPrice, exitPrice,
      grossReturn, netReturn, holdDays: 0, exitReason,
      capitalAfter: capital,
    });
  }
  return trades;
}

// ══════════════════════════════════════════════════════════════
// 輸出
// ══════════════════════════════════════════════════════════════

function printDetailedResult(strategyName: string, description: string, trades: Trade[]) {
  console.log('\n' + '═'.repeat(130));
  console.log(`  ${strategyName}`);
  console.log(`  ${description}`);
  console.log(`  期間: ${BACKTEST_START} ~ ${BACKTEST_END} | 初始: ${INITIAL_CAPITAL.toLocaleString()} | 一次一檔`);
  console.log('═'.repeat(130) + '\n');

  console.log('   #  買入日      賣出日      代碼        名稱      買入價    賣出價    報酬率   持有  出場原因          帳戶餘額');
  console.log('  ' + '─'.repeat(115));

  for (const t of trades) {
    console.log(
      t.num.toString().padStart(4) + '  ' +
      t.entryDate + '  ' + t.exitDate + '  ' +
      t.symbol.padEnd(10) + '  ' +
      t.name.slice(0, 6).padEnd(8) +
      t.entryPrice.toFixed(1).padStart(8) + '  ' +
      t.exitPrice.toFixed(1).padStart(8) + '  ' +
      ((t.netReturn >= 0 ? '+' : '') + t.netReturn.toFixed(2) + '%').padStart(8) + ' ' +
      (t.holdDays + '天').padStart(4) + '  ' +
      t.exitReason.padEnd(16) + ' ' +
      t.capitalAfter.toLocaleString().padStart(12)
    );
  }
  console.log('  ' + '─'.repeat(115));

  // 統計
  const wins = trades.filter(t => t.netReturn > 0);
  const losses = trades.filter(t => t.netReturn <= 0);
  const totalProfit = wins.reduce((s, t) => s + t.netReturn, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.netReturn, 0));
  const avgWin = wins.length > 0 ? totalProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;
  const finalCap = trades.length > 0 ? trades[trades.length - 1].capitalAfter : INITIAL_CAPITAL;

  // 最大回撤
  let peak = INITIAL_CAPITAL, maxDD = 0;
  let cap = INITIAL_CAPITAL;
  for (const t of trades) {
    cap = t.capitalAfter;
    peak = Math.max(peak, cap);
    maxDD = Math.min(maxDD, (cap - peak) / peak * 100);
  }

  // 最大連續虧損
  let maxConsLoss = 0, curCons = 0;
  for (const t of trades) {
    if (t.netReturn <= 0) { curCons++; maxConsLoss = Math.max(maxConsLoss, curCons); } else curCons = 0;
  }

  console.log(`\n  初始資金:     ${INITIAL_CAPITAL.toLocaleString()}`);
  console.log(`  最終資金:     ${finalCap.toLocaleString()}`);
  console.log(`  總損益:       ${(finalCap - INITIAL_CAPITAL >= 0 ? '+' : '')}${(finalCap - INITIAL_CAPITAL).toLocaleString()}`);
  console.log(`  總報酬率:     ${((finalCap / INITIAL_CAPITAL - 1) * 100).toFixed(1)}%`);
  console.log(`  交易筆數:     ${trades.length}（勝 ${wins.length} / 負 ${losses.length}）`);
  console.log(`  勝率:         ${(trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0')}%`);
  console.log(`  平均每筆:     ${(trades.length > 0 ? (trades.reduce((s, t) => s + t.netReturn, 0) / trades.length).toFixed(2) : '0')}%`);
  console.log(`  平均獲利:     +${avgWin.toFixed(2)}%`);
  console.log(`  平均虧損:     -${avgLoss.toFixed(2)}%`);
  console.log(`  盈虧比:       ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'N/A'}`);
  console.log(`  PF:           ${totalLoss > 0 ? (totalProfit / totalLoss).toFixed(2) : 'N/A'}`);
  console.log(`  最大回撤:     ${maxDD.toFixed(1)}%`);
  console.log(`  最大連虧:     ${maxConsLoss}次`);
  console.log(`  平均持有:     ${(trades.length > 0 ? (trades.reduce((s, t) => s + t.holdDays, 0) / trades.length).toFixed(1) : '0')}天`);

  // 月度損益
  console.log('\n  月度損益:');
  const months = new Map<string, { count: number; profit: number; wins: number }>();
  for (const t of trades) {
    const m = t.exitDate.slice(0, 7);
    const prev = months.get(m) ?? { count: 0, profit: 0, wins: 0 };
    prev.count++;
    prev.profit += t.netReturn;
    if (t.netReturn > 0) prev.wins++;
    months.set(m, prev);
  }
  for (const [m, d] of [...months.entries()].sort()) {
    const bar = d.profit >= 0 ? '+'.repeat(Math.min(30, Math.round(d.profit))) : '-'.repeat(Math.min(30, Math.round(Math.abs(d.profit))));
    console.log(`    ${m}  ${d.count.toString().padStart(3)}筆  ${(d.profit >= 0 ? '+' : '') + d.profit.toFixed(1) + '%'}`.padEnd(35) + `勝率${(d.wins / d.count * 100).toFixed(0)}%  ${bar}`);
  }

  // 出場原因
  console.log('\n  出場原因:');
  const rc: Record<string, number> = {};
  for (const t of trades) rc[t.exitReason] = (rc[t.exitReason] || 0) + 1;
  for (const [r, c] of Object.entries(rc).sort((a, b) => b[1] - a[1]))
    console.log(`    ${r.padEnd(16)} ${c}筆 (${(c / trades.length * 100).toFixed(0)}%)`);
}

// ══════════════════════════════════════════════════════════════

async function main() {
  console.log('載入台股數據...');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

  const allStocks = new Map<string, { name: string; candles: R3Candle[] }>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: Candle[] }>)) {
    if (!data.candles || data.candles.length < 60) continue;
    try {
      const base = computeIndicators(data.candles);
      allStocks.set(sym, { name: data.name, candles: enrichCandles(base) });
    } catch {}
  }
  console.log(`  ${allStocks.size} 支股票載入完成`);

  const benchSymbol = allStocks.has('2330.TW') ? '2330.TW' : allStocks.keys().next().value;
  const tradingDays = allStocks.get(benchSymbol!)!.candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
  console.log(`  ${tradingDays.length} 個交易日\n`);

  // ── 52週新高 ──
  console.log('回測 52週新高動能...');
  const trades52 = run52WeekHigh(allStocks, tradingDays);
  printDetailedResult(
    '52週新高動能',
    '買入: 收盤接近52週新高(>95%) + 在MA20上方 + 紅K | 賣出: 破MA20 / 停損-10% / 持有20天',
    trades52,
  );

  // ── 缺口回填 ──
  console.log('\n回測 缺口回填...');
  const tradesGap = runGapReversion(allStocks, tradingDays);
  printDetailedResult(
    '缺口回填（當沖）',
    '買入: 多頭股跳空下跌>2% + RSI(2)<20 開盤買 | 賣出: 當日收盤賣 / 停損-3%',
    tradesGap,
  );
}

main().catch(console.error);
