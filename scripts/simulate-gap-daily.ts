/**
 * 缺口回填策略 — 模擬每日操作教學
 * 從指定日期開始，每天展示：
 *   前一晚的候選清單 → 隔天開盤哪支跳空 → 買賣結果
 *
 * Usage: npx tsx scripts/simulate-gap-daily.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles.json');

// ── RSI(2) 計算 ──
function computeRSI2(candles: CandleWithIndicators[]): (number | null)[] {
  const period = 2;
  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return result;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) result[period] = 100;
  else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) result[i] = 100;
    else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
  }
  return result;
}

// ── Main ──
async function main() {
  console.log('載入數據...\n');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

  interface StockData {
    name: string;
    candles: CandleWithIndicators[];
    rsi2: (number | null)[];
  }

  const allStocks = new Map<string, StockData>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: any[] }>)) {
    if (!data.candles || data.candles.length < 250) continue;
    try {
      const candles = computeIndicators(data.candles);
      const rsi2 = computeRSI2(candles);
      allStocks.set(sym, { name: data.name, candles, rsi2 });
    } catch { /* skip */ }
  }

  // 找出所有交易日
  const benchSym = allStocks.has('2330.TW') ? '2330.TW' : allStocks.keys().next().value;
  const benchCandles = allStocks.get(benchSym!)!.candles;
  const allDays = benchCandles.map(c => c.date?.slice(0, 10)).filter((d): d is string => !!d);

  // 篩選 2026-03-01 之後的交易日
  const startDate = '2026-01-01';
  const simDays = allDays.filter(d => d >= startDate);

  console.log(`模擬期間: ${simDays[0]} ~ ${simDays[simDays.length - 1]}（${simDays.length} 個交易日）`);
  console.log(`共 ${allStocks.size} 支股票\n`);

  const COST_RATE = 0.0044;
  let balance = 1_000_000;
  let totalTrades = 0;
  let wins = 0;

  for (let dayIdx = 1; dayIdx < simDays.length; dayIdx++) {
    const yesterday = simDays[dayIdx - 1];
    const today = simDays[dayIdx];

    // ═══ 前一晚：算候選清單 ═══
    interface Candidate {
      symbol: string;
      name: string;
      yesterdayClose: number;
      ma240: number;
      rsi2: number;
      gapThreshold: number; // 跳空門檻 = 昨收 × 0.98
    }
    const candidates: Candidate[] = [];

    for (const [symbol, stock] of allStocks) {
      const { candles, rsi2 } = stock;
      const yIdx = candles.findIndex(c => c.date?.slice(0, 10) === yesterday);
      if (yIdx < 0 || yIdx >= candles.length - 1) continue;

      const yCandle = candles[yIdx];
      const yRsi2 = rsi2[yIdx];

      // 條件1: 昨收 > MA240（年線之上，體質好）
      if (yCandle.ma240 == null || yCandle.close <= yCandle.ma240) continue;

      // 條件2: RSI(2) < 20（超賣）
      if (yRsi2 == null || yRsi2 >= 20) continue;

      candidates.push({
        symbol,
        name: stock.name,
        yesterdayClose: yCandle.close,
        ma240: yCandle.ma240,
        rsi2: +yRsi2.toFixed(1),
        gapThreshold: +(yCandle.close * 0.98).toFixed(1),
      });
    }

    // ═══ 今天開盤：看哪支跳空 ═══
    interface GapSignal {
      symbol: string;
      name: string;
      yesterdayClose: number;
      todayOpen: number;
      todayClose: number;
      todayLow: number;
      gapPct: number;
      rsi2: number;
    }
    const gapSignals: GapSignal[] = [];

    for (const cand of candidates) {
      const stock = allStocks.get(cand.symbol)!;
      const tIdx = stock.candles.findIndex(c => c.date?.slice(0, 10) === today);
      if (tIdx < 0) continue;

      const todayCandle = stock.candles[tIdx];
      const gapPct = (todayCandle.open - cand.yesterdayClose) / cand.yesterdayClose * 100;

      // 條件3: 跳空下跌 >2% 且 <7%
      if (gapPct > -2 || gapPct < -7) continue;

      gapSignals.push({
        symbol: cand.symbol,
        name: cand.name,
        yesterdayClose: cand.yesterdayClose,
        todayOpen: todayCandle.open,
        todayClose: todayCandle.close,
        todayLow: todayCandle.low,
        gapPct: +gapPct.toFixed(2),
        rsi2: cand.rsi2,
      });
    }

    // 按跳空幅度排序（跌最多的優先）
    gapSignals.sort((a, b) => a.gapPct - b.gapPct);

    // ═══ 輸出每日操作 ═══
    console.log('━'.repeat(80));
    console.log(`📅 ${yesterday} 晚上 — 準備明天 (${today}) 的候選清單`);
    console.log('━'.repeat(80));

    if (candidates.length === 0) {
      console.log('  候選池：0 支（沒有股票同時在年線上方且RSI(2)<20）');
      console.log(`  → ${today} 不用看盤，休息一天\n`);
      continue;
    }

    console.log(`  候選池：${candidates.length} 支（年線上方 + RSI(2)<20 超賣）`);
    // 只顯示前10支
    const showCandidates = candidates.slice(0, 10);
    for (const c of showCandidates) {
      console.log(`    ${c.symbol.padEnd(10)} ${c.name.slice(0, 6).padEnd(8)} 昨收 ${c.yesterdayClose.toFixed(1).padStart(7)}  RSI(2)=${(c.rsi2 + '').padStart(4)}  跳空門檻 < ${c.gapThreshold}`);
    }
    if (candidates.length > 10) {
      console.log(`    ... 還有 ${candidates.length - 10} 支`);
    }

    console.log();
    console.log(`  🔔 ${today} 早上 9:00 開盤：`);

    if (gapSignals.length === 0) {
      console.log('    → 沒有候選股跳空下跌 >2%，今天不做');
      console.log(`    💰 帳戶餘額: ${balance.toLocaleString()}\n`);
      continue;
    }

    // 取第一支（跌最多的）
    const trade = gapSignals[0];
    const entryPrice = trade.todayOpen;
    const stopLossPrice = entryPrice * 0.97;

    // 判斷是否觸發停損
    let exitPrice: number;
    let exitReason: string;
    if (trade.todayLow <= stopLossPrice) {
      exitPrice = stopLossPrice;
      exitReason = '停損 -3%';
    } else {
      exitPrice = trade.todayClose;
      exitReason = '收盤賣出';
    }

    const grossReturn = (exitPrice - entryPrice) / entryPrice;
    const netReturn = grossReturn - COST_RATE;
    const pnl = balance * netReturn;
    const oldBalance = balance;
    balance = Math.round(balance * (1 + netReturn));
    totalTrades++;
    if (netReturn > 0) wins++;

    console.log(`    ✅ 發現跳空！共 ${gapSignals.length} 支符合，選跌最多的：`);
    for (const g of gapSignals.slice(0, 5)) {
      const marker = g.symbol === trade.symbol ? ' ← 選這支' : '';
      console.log(`       ${g.symbol.padEnd(10)} ${g.name.slice(0, 6).padEnd(8)} 跳空 ${g.gapPct}%${marker}`);
    }
    if (gapSignals.length > 5) {
      console.log(`       ... 還有 ${gapSignals.length - 5} 支`);
    }

    console.log();
    console.log(`    📊 操作 ${trade.symbol} ${trade.name.slice(0, 6)}：`);
    console.log(`       9:00  開盤買入  ${entryPrice.toFixed(1)} 元`);
    if (exitReason === '停損 -3%') {
      console.log(`       盤中  跌破停損  ${stopLossPrice.toFixed(1)} 元 → 立刻賣出`);
    } else {
      console.log(`       13:30 收盤賣出  ${exitPrice.toFixed(1)} 元`);
    }

    const returnPct = (netReturn * 100).toFixed(2);
    const emoji = netReturn > 0 ? '🟢' : '🔴';
    console.log(`       結果: ${emoji} ${netReturn > 0 ? '+' : ''}${returnPct}%（${exitReason}）`);
    console.log(`       損益: ${pnl > 0 ? '+' : ''}${Math.round(pnl).toLocaleString()} 元`);
    console.log(`    💰 帳戶餘額: ${oldBalance.toLocaleString()} → ${balance.toLocaleString()}`);
    console.log();
  }

  // ═══ 總結 ═══
  console.log('━'.repeat(80));
  console.log('📊 模擬總結');
  console.log('━'.repeat(80));
  console.log(`  期間: ${simDays[0]} ~ ${simDays[simDays.length - 1]}`);
  console.log(`  交易日: ${simDays.length} 天`);
  console.log(`  實際交易: ${totalTrades} 筆`);
  console.log(`  勝率: ${totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : 0}%（${wins}勝 ${totalTrades - wins}負）`);
  console.log(`  初始資金: 1,000,000`);
  console.log(`  最終資金: ${balance.toLocaleString()}`);
  console.log(`  總報酬: ${((balance - 1_000_000) / 1_000_000 * 100).toFixed(1)}%`);
}

main().catch(console.error);
