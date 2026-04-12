/**
 * V型反轉策略 — 1/1起詳細回測（朱家泓K線書）
 * 100萬起步，一次一檔，逐筆顯示
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles.json');
const START_DATE = '2026-01-01';
const COST_RATE = 0.0044;

function scanVReversal(candles: CandleWithIndicators[], idx: number): {
  pass: boolean; deviation?: number; consecutiveDown?: number;
  closePosition?: number; volRatio?: number;
} {
  if (idx < 5) return { pass: false };
  const today = candles[idx];
  if (today.ma20 == null || today.avgVol5 == null) return { pass: false };

  let consecutiveDown = 0;
  for (let i = idx - 1; i >= Math.max(0, idx - 10); i--) {
    if (candles[i].close < candles[i].open) consecutiveDown++;
    else break;
  }
  if (consecutiveDown < 3) return { pass: false };

  const deviation = (today.close - today.ma20) / today.ma20;
  if (deviation > -0.12) return { pass: false };

  const range = today.high - today.low;
  if (range <= 0) return { pass: false };
  const closePosition = (today.close - today.low) / range;
  if (closePosition < 0.4) return { pass: false };

  const volRatio = today.volume / today.avgVol5;
  if (volRatio < 1.2) return { pass: false };

  // 長期趨勢過濾：MA20 不能長期下降
  if (idx >= 20) {
    const ma20_20ago = candles[idx - 20].ma20;
    const ma20_40ago = idx >= 40 ? candles[idx - 40].ma20 : null;
    if (ma20_20ago != null && ma20_40ago != null && ma20_20ago < ma20_40ago) {
      return { pass: false };
    }
  }

  return {
    pass: true,
    deviation: +(deviation * 100).toFixed(1),
    consecutiveDown,
    closePosition: +closePosition.toFixed(2),
    volRatio: +volRatio.toFixed(1),
  };
}

async function main() {
  console.log('載入數據...');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

  const allStocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: any[] }>)) {
    if (!data.candles || data.candles.length < 60) continue;
    try {
      allStocks.set(sym, { name: data.name || sym, candles: computeIndicators(data.candles) });
    } catch { /* skip */ }
  }

  // 建立交易日列表
  const benchSym = allStocks.has('2330.TW') ? '2330.TW' : allStocks.keys().next().value;
  const benchCandles = allStocks.get(benchSym!)!.candles;
  const allDays = benchCandles.map(c => c.date?.slice(0, 10)).filter((d): d is string => !!d);
  const simDays = allDays.filter(d => d >= START_DATE);

  console.log(`${allStocks.size} 支股票，模擬期間: ${simDays[0]} ~ ${simDays[simDays.length - 1]}\n`);

  console.log('══════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  V型反轉（朱家泓）');
  console.log('  買入: 連跌3天+ | 偏離MA20≥12% | 反轉K棒(收盤位>40%) | 放量1.2倍');
  console.log('  賣出: 停損-7% / 目標+10% / 最多持有5天');
  console.log('  期間: 2026-01-01 ~ 最新 | 初始: 1,000,000 | 一次一檔');
  console.log('══════════════════════════════════════════════════════════════════════════════════════════════\n');

  let balance = 1_000_000;
  let tradeNum = 0;
  let wins = 0;
  let inPosition = false;
  let entryPrice = 0;
  let entryDate = '';
  let entrySymbol = '';
  let entryName = '';
  let entryIdx = 0;
  let holdDays = 0;
  let maxBalance = balance;
  let minBalance = balance;
  let maxDrawdown = 0;

  console.log('   #  訊號日      買入日      賣出日      代碼        名稱      買入價    賣出價    報酬率   持有  出場原因          帳戶餘額');
  console.log('  ' + '─'.repeat(110));

  for (let dayIdx = 0; dayIdx < simDays.length; dayIdx++) {
    const today = simDays[dayIdx];

    // 如果在持倉中，檢查出場
    if (inPosition) {
      const stock = allStocks.get(entrySymbol);
      if (!stock) continue;
      const tIdx = stock.candles.findIndex(c => c.date?.slice(0, 10) === today);
      if (tIdx < 0) continue;

      holdDays++;
      const candle = stock.candles[tIdx];
      const lowReturn = (candle.low - entryPrice) / entryPrice;
      const highReturn = (candle.high - entryPrice) / entryPrice;
      const closeReturn = (candle.close - entryPrice) / entryPrice;

      let exitPrice = 0;
      let exitReason = '';

      if (lowReturn <= -0.07) {
        exitPrice = entryPrice * 0.93;
        exitReason = '停損-7%';
      } else if (highReturn >= 0.10) {
        exitPrice = entryPrice * 1.10;
        exitReason = '目標+10%';
      } else if (holdDays >= 5) {
        exitPrice = candle.close;
        exitReason = '持有5天';
      } else if (candle.ma20 != null && candle.close > candle.ma20 && closeReturn > 0.03) {
        exitPrice = candle.close;
        exitReason = '回MA20上';
      }

      if (exitPrice > 0) {
        const grossReturn = (exitPrice - entryPrice) / entryPrice;
        const netReturn = grossReturn - COST_RATE;
        const pnl = balance * netReturn;
        balance = Math.round(balance * (1 + netReturn));
        tradeNum++;
        if (netReturn > 0) wins++;

        if (balance > maxBalance) maxBalance = balance;
        if (balance < minBalance) minBalance = balance;
        const dd = (balance - maxBalance) / maxBalance;
        if (dd < maxDrawdown) maxDrawdown = dd;

        const returnStr = (netReturn * 100).toFixed(2);
        const emoji = netReturn > 0 ? '+' : '';
        console.log(
          `  ${String(tradeNum).padStart(2)}  ${entryDate}  ${simDays[dayIdx - holdDays + 1] || entryDate}  ${today}  ` +
          `${entrySymbol.padEnd(10)}  ${entryName.slice(0, 6).padEnd(8)}` +
          `${entryPrice.toFixed(1).padStart(8)}  ${exitPrice.toFixed(1).padStart(8)}  ` +
          `${(emoji + returnStr + '%').padStart(8)}  ${(holdDays + '天').padStart(3)}  ` +
          `${exitReason.padEnd(16)}  ${balance.toLocaleString().padStart(12)}`
        );

        inPosition = false;
      }
      continue; // 持倉中不找新訊號
    }

    // 不在持倉中，掃描訊號
    interface Signal {
      symbol: string; name: string; deviation: number;
      consecutiveDown: number; closePosition: number; volRatio: number;
      nextDayOpen: number; signalDate: string;
    }
    const signals: Signal[] = [];

    for (const [symbol, stock] of allStocks) {
      const { candles } = stock;
      // 找昨天的 index（訊號在前一天收盤產生，隔天開盤買）
      const yesterdayDate = dayIdx > 0 ? simDays[dayIdx - 1] : null;
      if (!yesterdayDate) continue;

      const yIdx = candles.findIndex(c => c.date?.slice(0, 10) === yesterdayDate);
      if (yIdx < 25 || yIdx >= candles.length - 1) continue;

      const result = scanVReversal(candles, yIdx);
      if (!result.pass) continue;

      // 找今天的開盤價
      const tIdx = candles.findIndex(c => c.date?.slice(0, 10) === today);
      if (tIdx < 0) continue;

      signals.push({
        symbol,
        name: stock.name,
        deviation: result.deviation!,
        consecutiveDown: result.consecutiveDown!,
        closePosition: result.closePosition!,
        volRatio: result.volRatio!,
        nextDayOpen: candles[tIdx].open,
        signalDate: yesterdayDate,
      });
    }

    if (signals.length > 0) {
      // 選偏離最大的（跌最深的）
      signals.sort((a, b) => a.deviation - b.deviation);
      const pick = signals[0];

      inPosition = true;
      entryPrice = pick.nextDayOpen;
      entryDate = pick.signalDate;
      entrySymbol = pick.symbol;
      entryName = pick.name;
      holdDays = 0;
    }
  }

  // 如果最後還在持倉中
  if (inPosition) {
    console.log(`  (最後一筆 ${entrySymbol} 仍在持倉中，未計入)`);
  }

  console.log('  ' + '─'.repeat(110));
  console.log();
  console.log(`  初始資金:     1,000,000`);
  console.log(`  最終資金:     ${balance.toLocaleString()}`);
  console.log(`  總損益:       ${balance - 1_000_000 >= 0 ? '+' : ''}${(balance - 1_000_000).toLocaleString()}`);
  console.log(`  總報酬率:     ${((balance - 1_000_000) / 1_000_000 * 100).toFixed(1)}%`);
  console.log(`  交易筆數:     ${tradeNum}（勝 ${wins} / 負 ${tradeNum - wins}）`);
  console.log(`  勝率:         ${(wins / tradeNum * 100).toFixed(1)}%`);
  console.log(`  最大回撤:     ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  最低餘額:     ${minBalance.toLocaleString()}`);
}

main().catch(console.error);
