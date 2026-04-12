/**
 * 0050 ETF 多策略回測
 * 不用選股，只做0050，測試多種進出場策略
 * 數據期間用全部可用數據
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles.json');
const COST_RATE = 0.0044;
const INIT_BALANCE = 1_000_000;

// ── RSI(2) 計算 ──
function computeRSI(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= period; avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

interface Trade {
  entryDate: string; exitDate: string;
  entryPrice: number; exitPrice: number;
  returnPct: number; holdDays: number; exitReason: string;
}

function runBacktest(name: string, candles: CandleWithIndicators[], extraData: any, startDate: string) {
  const trades: Trade[] = [];
  let balance = INIT_BALANCE;
  let maxBal = balance, minBal = balance, maxDD = 0;
  let inPos = false, entryPrice = 0, entryDate = '', holdDays = 0;

  const { rsi2, rsi14, ibs, ma5, ma20, ma60, ma200 } = extraData;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const date = c.date?.slice(0, 10) || '';
    if (date < startDate) continue;

    if (inPos) {
      holdDays++;
      let exitPrice = 0, exitReason = '';

      if (name === 'RSI(2)均值回歸') {
        // 出場：close > MA5 或 RSI(2) > 70 或 持有10天
        if (c.close > (ma5[i] ?? Infinity)) { exitPrice = c.close; exitReason = '回MA5上'; }
        else if ((rsi2[i] ?? 0) > 70) { exitPrice = c.close; exitReason = 'RSI(2)>70'; }
        else if (holdDays >= 10) { exitPrice = c.close; exitReason = '持有10天'; }
      } else if (name === 'IBS均值回歸') {
        if ((ibs[i] ?? 0) > 0.8) { exitPrice = c.close; exitReason = 'IBS>0.8'; }
        else if (holdDays >= 10) { exitPrice = c.close; exitReason = '持有10天'; }
        else if ((c.low - entryPrice) / entryPrice <= -0.05) { exitPrice = entryPrice * 0.95; exitReason = '停損-5%'; }
      } else if (name === 'RSI(2)+IBS組合') {
        if (c.close > (ma5[i] ?? Infinity)) { exitPrice = c.close; exitReason = '回MA5上'; }
        else if ((rsi2[i] ?? 0) > 65 && (ibs[i] ?? 0) > 0.7) { exitPrice = c.close; exitReason = 'RSI+IBS回升'; }
        else if (holdDays >= 8) { exitPrice = c.close; exitReason = '持有8天'; }
        else if ((c.low - entryPrice) / entryPrice <= -0.05) { exitPrice = entryPrice * 0.95; exitReason = '停損-5%'; }
      } else if (name === '月底效應') {
        if (holdDays >= 5) { exitPrice = c.close; exitReason = '持有5天'; }
      } else if (name === 'MA20回踩') {
        if (c.close > (ma20[i] ?? 0) * 1.03) { exitPrice = c.close; exitReason = '反彈3%'; }
        else if (holdDays >= 10) { exitPrice = c.close; exitReason = '持有10天'; }
        else if ((c.low - entryPrice) / entryPrice <= -0.05) { exitPrice = entryPrice * 0.95; exitReason = '停損-5%'; }
      } else if (name === 'BB下軌反彈') {
        if (c.close > c.ma20!) { exitPrice = c.close; exitReason = '回MA20'; }
        else if (holdDays >= 10) { exitPrice = c.close; exitReason = '持有10天'; }
        else if ((c.low - entryPrice) / entryPrice <= -0.05) { exitPrice = entryPrice * 0.95; exitReason = '停損-5%'; }
      }

      if (exitPrice > 0) {
        const net = (exitPrice - entryPrice) / entryPrice - COST_RATE;
        balance = Math.round(balance * (1 + net));
        if (balance > maxBal) maxBal = balance;
        if (balance < minBal) minBal = balance;
        const dd = (balance - maxBal) / maxBal;
        if (dd < maxDD) maxDD = dd;
        trades.push({ entryDate, exitDate: date, entryPrice, exitPrice, returnPct: +(net * 100).toFixed(2), holdDays, exitReason });
        inPos = false;
      }
      continue;
    }

    // 進場條件
    let enter = false;

    if (name === 'RSI(2)均值回歸') {
      // close > MA200, RSI(2) < 5, close < MA5
      if (ma200[i] != null && c.close > ma200[i]! && (rsi2[i] ?? 100) < 5 && ma5[i] != null && c.close < ma5[i]!) enter = true;
    } else if (name === 'IBS均值回歸') {
      // IBS < 0.2, close > MA200
      if (ma200[i] != null && c.close > ma200[i]! && (ibs[i] ?? 1) < 0.2) enter = true;
    } else if (name === 'RSI(2)+IBS組合') {
      // RSI(2) < 10 AND IBS < 0.3 AND close > MA200
      if (ma200[i] != null && c.close > ma200[i]! && (rsi2[i] ?? 100) < 10 && (ibs[i] ?? 1) < 0.3) enter = true;
    } else if (name === '月底效應') {
      // 每月最後2個交易日買入
      const nextDate = i + 1 < candles.length ? candles[i + 1].date?.slice(0, 10) || '' : '';
      const thisMonth = date.slice(0, 7);
      const nextMonth = nextDate.slice(0, 7);
      if (thisMonth !== nextMonth && nextDate !== '') enter = true;
      // 也在倒數第2天進場
      if (i + 2 < candles.length) {
        const next2Date = candles[i + 2].date?.slice(0, 10) || '';
        const next2Month = next2Date.slice(0, 7);
        if (thisMonth !== next2Month && nextMonth === thisMonth) enter = true;
      }
    } else if (name === 'MA20回踩') {
      // close 從上方碰到 MA20（回踩支撐）
      if (ma20[i] != null && ma60[i] != null && c.close > ma60[i]! && // 多頭
          p.close > (candles[i-1].ma20 ?? 0) && // 昨天在MA20上
          c.close <= ma20[i]! * 1.01 && c.close >= ma20[i]! * 0.98 && // 今天碰到MA20
          c.close > c.open) { // 收紅K
        enter = true;
      }
    } else if (name === 'BB下軌反彈') {
      // 碰到布林下軌 + 收紅
      if (c.bbLower != null && c.low <= c.bbLower && c.close > c.open && ma200[i] != null && c.close > ma200[i]!) enter = true;
    }

    if (enter) {
      // 隔日開盤買
      if (i + 1 < candles.length) {
        const next = candles[i + 1];
        inPos = true;
        entryPrice = next.open;
        entryDate = next.date?.slice(0, 10) || '';
        holdDays = 0;
      }
    }
  }

  return { trades, finalBalance: balance, maxDD, minBal };
}

async function main() {
  console.log('載入 0050 數據...');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

  // 嘗試找 0050
  let etfSymbol = '';
  let etfData: any = null;
  for (const sym of ['0050.TW', '0050.TWO']) {
    if (raw.stocks[sym]) { etfSymbol = sym; etfData = raw.stocks[sym]; break; }
  }
  if (!etfData) {
    console.log('找不到 0050 數據！嘗試其他 ETF...');
    for (const sym of ['006208.TW', '006208.TWO']) {
      if (raw.stocks[sym]) { etfSymbol = sym; etfData = raw.stocks[sym]; break; }
    }
  }
  if (!etfData) {
    console.log('找不到任何 ETF 數據。嘗試用加權指數或大型股代替...');
    // 用台積電當替代測試
    for (const sym of ['2330.TW']) {
      if (raw.stocks[sym]) { etfSymbol = sym; etfData = raw.stocks[sym]; break; }
    }
  }

  console.log(`使用: ${etfSymbol} (${etfData.name || etfSymbol})`);
  const candles = computeIndicators(etfData.candles);
  console.log(`K線數: ${candles.length}，期間: ${candles[0]?.date?.slice(0,10)} ~ ${candles[candles.length-1]?.date?.slice(0,10)}\n`);

  // 預計算指標
  const closes = candles.map(c => c.close);
  const rsi2 = computeRSI(closes, 2);
  const rsi14 = computeRSI(closes, 14);
  const ibs = candles.map(c => {
    const range = c.high - c.low;
    return range > 0 ? (c.close - c.low) / range : 0.5;
  });

  // MA
  const calcMA = (arr: number[], period: number): (number | null)[] => {
    const result: (number | null)[] = new Array(arr.length).fill(null);
    for (let i = period - 1; i < arr.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += arr[j];
      result[i] = sum / period;
    }
    return result;
  };

  const ma5 = calcMA(closes, 5);
  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, 60);
  const ma200 = calcMA(closes, 200);

  const extraData = { rsi2, rsi14, ibs, ma5, ma20, ma60, ma200 };

  // 回測期間：用最近3年
  const allDates = candles.map(c => c.date?.slice(0, 10) || '');
  const startDate = '2024-01-01'; // 用2年數據

  const strategies = [
    'RSI(2)均值回歸',
    'IBS均值回歸',
    'RSI(2)+IBS組合',
    '月底效應',
    'MA20回踩',
    'BB下軌反彈',
  ];

  console.log('══════════════════════════════════════════════════════════════════════════════════════');
  console.log(`  0050 ETF 策略回測（${etfSymbol}）`);
  console.log(`  期間: ${startDate} ~ ${allDates[allDates.length - 1]} | 初始: 1,000,000 | 費用: 0.44%`);
  console.log('══════════════════════════════════════════════════════════════════════════════════════\n');

  const results: { name: string; trades: number; wins: number; wr: string; totalReturn: string; pf: string; maxDD: string; avgHold: string; avgReturn: string; finalBal: number }[] = [];

  for (const name of strategies) {
    const { trades, finalBalance, maxDD, minBal } = runBacktest(name, candles, extraData, startDate);
    const wins = trades.filter(t => t.returnPct > 0).length;
    const losses = trades.filter(t => t.returnPct <= 0).length;
    const totalGain = trades.filter(t => t.returnPct > 0).reduce((s, t) => s + t.returnPct, 0);
    const totalLoss = Math.abs(trades.filter(t => t.returnPct <= 0).reduce((s, t) => s + t.returnPct, 0));
    const pf = totalLoss > 0 ? (totalGain / totalLoss).toFixed(2) : '∞';
    const avgHold = trades.length > 0 ? (trades.reduce((s, t) => s + t.holdDays, 0) / trades.length).toFixed(1) : '0';
    const avgReturn = trades.length > 0 ? (trades.reduce((s, t) => s + t.returnPct, 0) / trades.length).toFixed(2) : '0';

    results.push({
      name, trades: trades.length, wins,
      wr: trades.length > 0 ? (wins / trades.length * 100).toFixed(1) + '%' : '0%',
      totalReturn: ((finalBalance - INIT_BALANCE) / INIT_BALANCE * 100).toFixed(1) + '%',
      pf, maxDD: (maxDD * 100).toFixed(1) + '%', avgHold, avgReturn: avgReturn + '%',
      finalBal: finalBalance,
    });

    // 印出詳細交易
    console.log(`─── ${name} ───────────────────────────────────────────────────────`);
    if (trades.length === 0) {
      console.log('  (無交易)\n');
      continue;
    }
    console.log(`  #   買入日      賣出日      買入價    賣出價    報酬率   持有  出場原因`);
    for (let t = 0; t < trades.length; t++) {
      const tr = trades[t];
      console.log(
        `  ${String(t + 1).padStart(2)}  ${tr.entryDate}  ${tr.exitDate}  ` +
        `${tr.entryPrice.toFixed(1).padStart(8)}  ${tr.exitPrice.toFixed(1).padStart(8)}  ` +
        `${(tr.returnPct >= 0 ? '+' : '') + tr.returnPct + '%'}`.padStart(8) + `  ${(tr.holdDays + '天').padStart(3)}  ${tr.exitReason}`
      );
    }
    console.log(`  → ${trades.length}筆 | 勝率 ${(wins / trades.length * 100).toFixed(0)}% | PF ${pf} | 100萬→${finalBalance.toLocaleString()} (${((finalBalance - INIT_BALANCE) / INIT_BALANCE * 100).toFixed(1)}%)\n`);
  }

  // 總排名
  console.log('\n══════════════════════════════════════════════════════════════════════════════════════');
  console.log('  ETF策略總排名');
  console.log('══════════════════════════════════════════════════════════════════════════════════════');
  console.log('  排名  策略              交易數  勝率    PF     總報酬    最大回撤   平均持有  100萬→');
  console.log('  ' + '─'.repeat(85));

  results.sort((a, b) => b.finalBal - a.finalBal);
  results.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}    ${r.name.padEnd(16)}  ${String(r.trades).padStart(4)}  ${r.wr.padStart(6)}  ${r.pf.padStart(5)}  ${r.totalReturn.padStart(8)}  ${r.maxDD.padStart(8)}  ${(r.avgHold + '天').padStart(6)}  ${r.finalBal.toLocaleString()}`
    );
  });
}

main().catch(console.error);
