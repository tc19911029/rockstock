/**
 * Round 4 策略回測 — 網上找到的高勝率策略
 *
 * 1. Triple RSI (Larry Connors R3) — 91% WR, PF 5 on SPY
 * 2. Williams %R 均值回歸 — 81% WR, PF 3.2 on SPY
 * 3. 3日RSI連降 + 趨勢 — 簡化版 Triple RSI
 * 4. V型反轉加強版（放寬條件增加交易次數）
 *
 * 在台股個股上測試，100萬一次一檔
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles.json');
const COST_RATE = 0.0044;
const INIT_BALANCE = 1_000_000;

// ── 自訂 RSI 計算 ──
function computeCustomRSI(candles: CandleWithIndicators[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(50);
  if (candles.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    if (ch > 0) avgGain += ch; else avgLoss += Math.abs(ch);
  }
  avgGain /= period; avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? Math.abs(ch) : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

// Williams %R = (highest high - close) / (highest high - lowest low) * -100
function computeWilliamsR(candles: CandleWithIndicators[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(-50);
  for (let i = period - 1; i < candles.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    const range = hh - ll;
    result[i] = range > 0 ? ((hh - candles[i].close) / range) * -100 : -50;
  }
  return result;
}

interface Trade {
  signalDate: string; entryDate: string; exitDate: string;
  symbol: string; name: string;
  entryPrice: number; exitPrice: number;
  returnPct: number; holdDays: number; exitReason: string;
}

interface StrategyResult {
  name: string; description: string;
  trades: Trade[]; finalBalance: number; maxDD: number;
}

async function main() {
  console.log('載入數據...');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

  interface StockEnriched {
    name: string;
    candles: CandleWithIndicators[];
    rsi2: number[];
    rsi5: number[];
    wr2: number[];
  }

  const allStocks = new Map<string, StockEnriched>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: any[] }>)) {
    if (!data.candles || data.candles.length < 250) continue;
    try {
      const candles = computeIndicators(data.candles);
      allStocks.set(sym, {
        name: data.name || sym,
        candles,
        rsi2: computeCustomRSI(candles, 2),
        rsi5: computeCustomRSI(candles, 5),
        wr2: computeWilliamsR(candles, 2),
      });
    } catch { /* skip */ }
  }

  const benchSym = allStocks.has('2330.TW') ? '2330.TW' : allStocks.keys().next().value;
  const allDays = allStocks.get(benchSym!)!.candles.map(c => c.date?.slice(0, 10)).filter((d): d is string => !!d);
  const START = '2024-01-01';
  const simDays = allDays.filter(d => d >= START);
  console.log(`${allStocks.size} 支股票，${simDays.length} 交易日 (${simDays[0]} ~ ${simDays[simDays.length - 1]})\n`);

  // ════════════════════════════════════════════════════════════
  // 策略定義
  // ════════════════════════════════════════════════════════════

  function runStrategy(
    stratName: string,
    checkEntry: (stock: StockEnriched, idx: number) => boolean,
    checkExit: (stock: StockEnriched, idx: number, entryPrice: number, holdDays: number) => { exit: boolean; reason: string },
  ): { trades: Trade[]; finalBalance: number; maxDD: number } {
    const trades: Trade[] = [];
    let balance = INIT_BALANCE;
    let maxBal = balance, maxDD = 0;
    let inPos = false, entryPrice = 0, entryDate = '', entrySymbol = '', entryName = '', holdDays = 0;

    for (let dayIdx = 0; dayIdx < simDays.length; dayIdx++) {
      const today = simDays[dayIdx];

      if (inPos) {
        const stock = allStocks.get(entrySymbol);
        if (!stock) { inPos = false; continue; }
        const tIdx = stock.candles.findIndex(c => c.date?.slice(0, 10) === today);
        if (tIdx < 0) continue;
        holdDays++;

        const { exit, reason } = checkExit(stock, tIdx, entryPrice, holdDays);
        if (exit) {
          let exitPrice: number;
          if (reason.includes('停損')) {
            const pct = parseFloat(reason.match(/-(\d+)/)![1]) / 100;
            exitPrice = entryPrice * (1 - pct);
          } else {
            exitPrice = stock.candles[tIdx].close;
          }
          const net = (exitPrice - entryPrice) / entryPrice - COST_RATE;
          balance = Math.round(balance * (1 + net));
          if (balance > maxBal) maxBal = balance;
          const dd = (balance - maxBal) / maxBal;
          if (dd < maxDD) maxDD = dd;
          trades.push({
            signalDate: entryDate, entryDate, exitDate: today,
            symbol: entrySymbol, name: entryName,
            entryPrice, exitPrice, returnPct: +(net * 100).toFixed(2),
            holdDays, exitReason: reason,
          });
          inPos = false;
        }
        continue;
      }

      // 找訊號
      const yesterday = dayIdx > 0 ? simDays[dayIdx - 1] : null;
      if (!yesterday) continue;

      interface Signal { symbol: string; name: string; score: number; nextOpen: number }
      const signals: Signal[] = [];

      for (const [symbol, stock] of allStocks) {
        const yIdx = stock.candles.findIndex(c => c.date?.slice(0, 10) === yesterday);
        if (yIdx < 5) continue;
        const tIdx = stock.candles.findIndex(c => c.date?.slice(0, 10) === today);
        if (tIdx < 0) continue;

        if (checkEntry(stock, yIdx)) {
          signals.push({
            symbol, name: stock.name,
            score: stock.rsi2[yIdx], // 用 RSI(2) 排序，越低越超賣
            nextOpen: stock.candles[tIdx].open,
          });
        }
      }

      if (signals.length > 0) {
        signals.sort((a, b) => a.score - b.score); // RSI最低的優先
        const pick = signals[0];
        inPos = true;
        entryPrice = pick.nextOpen;
        entryDate = today;
        entrySymbol = pick.symbol;
        entryName = pick.name;
        holdDays = 0;
      }
    }

    return { trades, finalBalance: balance, maxDD };
  }

  // ── 策略1: Triple RSI (R3) ──
  const r1 = runStrategy(
    'Triple RSI (R3)',
    (stock, idx) => {
      const c = stock.candles;
      if (idx < 200) return false;
      // close > MA200
      if (c[idx].ma240 == null || c[idx].close <= c[idx].ma240!) return false;
      // RSI(2) < 10
      if (stock.rsi2[idx] >= 10) return false;
      // RSI(2) 連降3天，第一天從 >60 開始降
      if (idx < 3) return false;
      if (stock.rsi2[idx] >= stock.rsi2[idx - 1]) return false;
      if (stock.rsi2[idx - 1] >= stock.rsi2[idx - 2]) return false;
      if (stock.rsi2[idx - 2] >= stock.rsi2[idx - 3]) return false;
      if (stock.rsi2[idx - 3] <= 60) return false;
      return true;
    },
    (stock, idx, entryPrice, holdDays) => {
      // 出場: RSI(2) > 70 或 持有10天 或 停損-7%
      if (stock.rsi2[idx] > 70) return { exit: true, reason: 'RSI(2)>70' };
      if (holdDays >= 10) return { exit: true, reason: '持有10天' };
      if ((stock.candles[idx].low - entryPrice) / entryPrice <= -0.07) return { exit: true, reason: '停損-7%' };
      return { exit: false, reason: '' };
    }
  );

  // ── 策略2: Williams %R 均值回歸 ──
  const r2 = runStrategy(
    'Williams %R 回歸',
    (stock, idx) => {
      const c = stock.candles;
      if (idx < 200) return false;
      if (c[idx].ma240 == null || c[idx].close <= c[idx].ma240!) return false;
      // Williams %R(2) < -95 (極度超賣)
      if (stock.wr2[idx] > -95) return false;
      // 收紅K（反轉跡象）
      if (c[idx].close <= c[idx].open) return false;
      return true;
    },
    (stock, idx, entryPrice, holdDays) => {
      // 出場: Williams %R > -20 或 持有7天 或 停損-5%
      if (stock.wr2[idx] > -20) return { exit: true, reason: 'WR>-20' };
      if (holdDays >= 7) return { exit: true, reason: '持有7天' };
      if ((stock.candles[idx].low - entryPrice) / entryPrice <= -0.05) return { exit: true, reason: '停損-5%' };
      return { exit: false, reason: '' };
    }
  );

  // ── 策略3: RSI(5) 三連降 (簡化版 Triple RSI) ──
  const r3 = runStrategy(
    'RSI(5)三連降',
    (stock, idx) => {
      const c = stock.candles;
      if (idx < 200) return false;
      if (c[idx].ma240 == null || c[idx].close <= c[idx].ma240!) return false;
      // RSI(5) < 30 且連降3天
      if (stock.rsi5[idx] >= 30) return false;
      if (idx < 3) return false;
      if (stock.rsi5[idx] >= stock.rsi5[idx - 1]) return false;
      if (stock.rsi5[idx - 1] >= stock.rsi5[idx - 2]) return false;
      if (stock.rsi5[idx - 2] >= stock.rsi5[idx - 3]) return false;
      // 收盤位在下半部（還沒反彈）
      const range = c[idx].high - c[idx].low;
      if (range > 0 && (c[idx].close - c[idx].low) / range > 0.5) return false;
      return true;
    },
    (stock, idx, entryPrice, holdDays) => {
      if (stock.rsi5[idx] > 50) return { exit: true, reason: 'RSI(5)>50' };
      if (holdDays >= 10) return { exit: true, reason: '持有10天' };
      if ((stock.candles[idx].low - entryPrice) / entryPrice <= -0.07) return { exit: true, reason: '停損-7%' };
      return { exit: false, reason: '' };
    }
  );

  // ── 策略4: V反轉放寬版（偏離10%+連跌2天） ──
  const r4 = runStrategy(
    'V反轉放寬版',
    (stock, idx) => {
      const c = stock.candles;
      if (idx < 25) return false;
      if (c[idx].ma20 == null || c[idx].avgVol5 == null) return false;

      // 放寬：連跌2天（原本3天）
      let consDown = 0;
      for (let i = idx - 1; i >= Math.max(0, idx - 10); i--) {
        if (c[i].close < c[i].open) consDown++; else break;
      }
      if (consDown < 2) return false;

      // 放寬：偏離10%（原本12%）
      const dev = (c[idx].close - c[idx].ma20!) / c[idx].ma20!;
      if (dev > -0.10) return false;

      // 反轉K棒
      const range = c[idx].high - c[idx].low;
      if (range <= 0) return false;
      if ((c[idx].close - c[idx].low) / range < 0.35) return false;

      // 放量
      if (c[idx].volume / c[idx].avgVol5! < 1.0) return false;

      return true;
    },
    (stock, idx, entryPrice, holdDays) => {
      if ((stock.candles[idx].low - entryPrice) / entryPrice <= -0.07) return { exit: true, reason: '停損-7%' };
      if ((stock.candles[idx].high - entryPrice) / entryPrice >= 0.10) return { exit: true, reason: '目標+10%' };
      if (holdDays >= 5) return { exit: true, reason: '持有5天' };
      if (stock.candles[idx].ma20 != null && stock.candles[idx].close > stock.candles[idx].ma20!) {
        return { exit: true, reason: '回MA20' };
      }
      return { exit: false, reason: '' };
    }
  );

  // ── 策略5: 大跌買入（日跌幅>5%+年線上+放量） ──
  const r5 = runStrategy(
    '大跌反彈',
    (stock, idx) => {
      const c = stock.candles;
      if (idx < 200) return false;
      if (c[idx].ma240 == null || c[idx].close <= c[idx].ma240! * 0.9) return false; // 不能離年線太遠
      if (c[idx].close >= c[idx].ma240!) return false; // 要在年線下方（剛跌破）
      // 當日跌幅 > 5%
      const dayReturn = (c[idx].close - c[idx].open) / c[idx].open;
      if (dayReturn > -0.05) return false;
      // 放量
      if (c[idx].avgVol5 == null || c[idx].volume / c[idx].avgVol5 < 1.5) return false;
      // 不是長期下跌趨勢
      if (c[idx].ma20 != null && c[idx].ma60 != null && c[idx].ma20 < c[idx].ma60) return false;
      return true;
    },
    (stock, idx, entryPrice, holdDays) => {
      if ((stock.candles[idx].low - entryPrice) / entryPrice <= -0.05) return { exit: true, reason: '停損-5%' };
      if ((stock.candles[idx].close - entryPrice) / entryPrice >= 0.08) return { exit: true, reason: '目標+8%' };
      if (holdDays >= 5) return { exit: true, reason: '持有5天' };
      return { exit: false, reason: '' };
    }
  );

  // ── 策略6: 恐慌反轉（RSI2<5 + 大跌 + 長下影線） ──
  const r6 = runStrategy(
    '恐慌反轉',
    (stock, idx) => {
      const c = stock.candles;
      if (idx < 200) return false;
      if (c[idx].ma240 == null) return false;
      // 年線上方或附近（不超過-15%）
      if (c[idx].close < c[idx].ma240! * 0.85) return false;
      // RSI(2) < 5（極度超賣）
      if (stock.rsi2[idx] >= 5) return false;
      // 長下影線：下影線 > 實體 * 2
      const body = Math.abs(c[idx].close - c[idx].open);
      const lowerShadow = Math.min(c[idx].open, c[idx].close) - c[idx].low;
      if (lowerShadow < body * 1.5) return false;
      return true;
    },
    (stock, idx, entryPrice, holdDays) => {
      if (stock.rsi2[idx] > 70) return { exit: true, reason: 'RSI>70' };
      if (holdDays >= 5) return { exit: true, reason: '持有5天' };
      if ((stock.candles[idx].low - entryPrice) / entryPrice <= -0.07) return { exit: true, reason: '停損-7%' };
      return { exit: false, reason: '' };
    }
  );

  // ════════════════════════════════════════════════════════════
  // 輸出結果
  // ════════════════════════════════════════════════════════════

  const strategies: { name: string; r: ReturnType<typeof runStrategy> }[] = [
    { name: 'Triple RSI (R3)', r: r1 },
    { name: 'Williams %R 回歸', r: r2 },
    { name: 'RSI(5)三連降', r: r3 },
    { name: 'V反轉放寬版', r: r4 },
    { name: '大跌反彈', r: r5 },
    { name: '恐慌反轉', r: r6 },
  ];

  for (const { name, r } of strategies) {
    const { trades, finalBalance, maxDD } = r;
    const wins = trades.filter(t => t.returnPct > 0).length;
    const totalGain = trades.filter(t => t.returnPct > 0).reduce((s, t) => s + t.returnPct, 0);
    const totalLoss = Math.abs(trades.filter(t => t.returnPct <= 0).reduce((s, t) => s + t.returnPct, 0));
    const pf = totalLoss > 0 ? (totalGain / totalLoss).toFixed(2) : '∞';
    const avgHold = trades.length > 0 ? (trades.reduce((s, t) => s + t.holdDays, 0) / trades.length).toFixed(1) : '-';

    console.log(`\n─── ${name} ───────────────────────────────────────────────`);
    console.log(`  交易: ${trades.length}筆 | 勝率: ${trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : 0}% | PF: ${pf} | 回撤: ${(maxDD * 100).toFixed(1)}%`);
    console.log(`  100萬 → ${finalBalance.toLocaleString()} (${((finalBalance - INIT_BALANCE) / INIT_BALANCE * 100).toFixed(1)}%) | 平均持有: ${avgHold}天`);

    if (trades.length > 0 && trades.length <= 30) {
      console.log(`\n  #   買入日      賣出日      代碼        名稱      買入     賣出     報酬    持有  出場`);
      for (let i = 0; i < trades.length; i++) {
        const t = trades[i];
        console.log(
          `  ${String(i + 1).padStart(2)}  ${t.entryDate}  ${t.exitDate}  ${t.symbol.padEnd(10)}  ${t.name.slice(0, 6).padEnd(8)}` +
          `${t.entryPrice.toFixed(1).padStart(7)}  ${t.exitPrice.toFixed(1).padStart(7)}  ` +
          `${(t.returnPct >= 0 ? '+' : '') + t.returnPct + '%'}`.padStart(8) + `  ${(t.holdDays + '天').padStart(3)}  ${t.exitReason}`
        );
      }
    } else if (trades.length > 30) {
      console.log(`  (${trades.length}筆交易太多，只顯示前15+後5筆)`);
      console.log(`\n  #   買入日      賣出日      代碼        名稱      買入     賣出     報酬    持有  出場`);
      for (let i = 0; i < 15; i++) {
        const t = trades[i];
        console.log(
          `  ${String(i + 1).padStart(2)}  ${t.entryDate}  ${t.exitDate}  ${t.symbol.padEnd(10)}  ${t.name.slice(0, 6).padEnd(8)}` +
          `${t.entryPrice.toFixed(1).padStart(7)}  ${t.exitPrice.toFixed(1).padStart(7)}  ` +
          `${(t.returnPct >= 0 ? '+' : '') + t.returnPct + '%'}`.padStart(8) + `  ${(t.holdDays + '天').padStart(3)}  ${t.exitReason}`
        );
      }
      console.log(`  ... (省略 ${trades.length - 20} 筆)`);
      for (let i = trades.length - 5; i < trades.length; i++) {
        const t = trades[i];
        console.log(
          `  ${String(i + 1).padStart(2)}  ${t.entryDate}  ${t.exitDate}  ${t.symbol.padEnd(10)}  ${t.name.slice(0, 6).padEnd(8)}` +
          `${t.entryPrice.toFixed(1).padStart(7)}  ${t.exitPrice.toFixed(1).padStart(7)}  ` +
          `${(t.returnPct >= 0 ? '+' : '') + t.returnPct + '%'}`.padStart(8) + `  ${(t.holdDays + '天').padStart(3)}  ${t.exitReason}`
        );
      }
    }
  }

  // 總排名
  console.log('\n\n══════════════════════════════════════════════════════════════════════════════');
  console.log('  Round 4 + 歷屆冠軍 總排名');
  console.log('══════════════════════════════════════════════════════════════════════════════');

  interface Rank { name: string; trades: number; wr: number; pf: string; totalReturn: number; maxDD: number; avgHold: string }
  const ranking: Rank[] = [];

  for (const { name, r } of strategies) {
    const { trades, finalBalance, maxDD } = r;
    const wins = trades.filter(t => t.returnPct > 0).length;
    const totalGain = trades.filter(t => t.returnPct > 0).reduce((s, t) => s + t.returnPct, 0);
    const totalLoss = Math.abs(trades.filter(t => t.returnPct <= 0).reduce((s, t) => s + t.returnPct, 0));
    ranking.push({
      name, trades: trades.length,
      wr: trades.length > 0 ? +(wins / trades.length * 100).toFixed(1) : 0,
      pf: totalLoss > 0 ? (totalGain / totalLoss).toFixed(2) : '∞',
      totalReturn: +((finalBalance - INIT_BALANCE) / INIT_BALANCE * 100).toFixed(1),
      maxDD: +(maxDD * 100).toFixed(1),
      avgHold: trades.length > 0 ? (trades.reduce((s, t) => s + t.holdDays, 0) / trades.length).toFixed(1) : '-',
    });
  }

  ranking.sort((a, b) => b.totalReturn - a.totalReturn);
  console.log('  排名  策略              交易  勝率    PF     報酬      回撤    持有');
  console.log('  ' + '─'.repeat(75));
  ranking.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}    ${r.name.padEnd(16)}  ${String(r.trades).padStart(4)}  ${(r.wr + '%').padStart(6)}  ${r.pf.padStart(5)}  ` +
      `${(r.totalReturn >= 0 ? '+' : '') + r.totalReturn + '%'}`.padStart(9) + `  ${(r.maxDD + '%').padStart(7)}  ${(r.avgHold + '天').padStart(5)}`
    );
  });
}

main().catch(console.error);
