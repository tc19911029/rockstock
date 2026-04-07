/**
 * A股量價突破策略 v2 — 加大盤過濾 + 移動停損
 *
 * 改進：
 * 1. 大盤過濾：上證指數 > MA20 才交易
 * 2. 移動停損：獲利 >10% 後，從最高點回落 -5% 出場
 * 3. 更嚴格量比：≥2.0
 * 4. 連續放量：近2日均量 > 5日均量
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const BACKTEST_START = '2025-04-01';
const BACKTEST_END   = '2026-04-04';
const INITIAL_CAPITAL = 1000000;

// 進場
const VOL_RATIO_MIN    = 2.0;
const BREAKOUT_DAYS    = 20;
const MIN_GAIN_PCT     = 3;

// 出場
const STOP_LOSS_PCT    = -8;
const TRAILING_ACTIVATE = 10;  // 啟動移動停損的門檻%
const TRAILING_STOP     = -5;  // 從最高點回落%
const TAKE_PROFIT_PCT   = 15;
const MAX_HOLD_DAYS     = 30;

// 費用
const ROUND_TRIP_COST = 0.16;

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');

interface Trade {
  entryDate: string; exitDate: string;
  symbol: string; name: string;
  entryPrice: number; exitPrice: number;
  netReturn: number; holdDays: number;
  exitReason: string; volRatio: number; dayGain: number;
}

function getMA(c: CandleWithIndicators[], i: number, p: number): number {
  let s = 0; const st = Math.max(0, i - p + 1);
  for (let j = st; j <= i; j++) s += c[j].close;
  return s / (i - st + 1);
}

function getHighest(c: CandleWithIndicators[], i: number, p: number): number {
  let m = -Infinity;
  for (let j = Math.max(0, i - p + 1); j <= i; j++) if (c[j].high > m) m = c[j].high;
  return m;
}

function getAvgVol(c: CandleWithIndicators[], i: number, p: number): number {
  let s = 0; const st = Math.max(0, i - p + 1);
  for (let j = st; j <= i; j++) s += (c[j].volume ?? 0);
  return s / (i - st + 1);
}

function simulateTrade(candles: CandleWithIndicators[], entryIdx: number, entryPrice: number): {
  exitIdx: number; exitPrice: number; exitReason: string;
} | null {
  const maxIdx = Math.min(entryIdx + MAX_HOLD_DAYS, candles.length - 1);
  let peakPrice = entryPrice;
  let trailingActive = false;

  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const c = candles[i];
    const currentReturn = (c.close - entryPrice) / entryPrice * 100;
    const peakReturn = (peakPrice - entryPrice) / entryPrice * 100;

    if (c.high > peakPrice) peakPrice = c.high;

    // 移動停損：獲利 >10% 後啟動，從最高點回落 -5%
    if (peakReturn >= TRAILING_ACTIVATE) trailingActive = true;
    if (trailingActive) {
      const drawdownFromPeak = (c.close - peakPrice) / peakPrice * 100;
      if (drawdownFromPeak <= TRAILING_STOP) {
        const exitPrice = +(peakPrice * (1 + TRAILING_STOP / 100)).toFixed(2);
        return { exitIdx: i, exitPrice, exitReason: '移動停損(峰值回落-5%)' };
      }
    }

    // 固定停損
    if (c.low <= entryPrice * (1 + STOP_LOSS_PCT / 100)) {
      return { exitIdx: i, exitPrice: +(entryPrice * (1 + STOP_LOSS_PCT / 100)).toFixed(2), exitReason: '停損-8%' };
    }

    // 停利：>15% 跌破 MA10
    if (currentReturn > TAKE_PROFIT_PCT) {
      const ma10 = getMA(candles, i, 10);
      if (c.close < ma10) {
        return { exitIdx: i, exitPrice: c.close, exitReason: '停利(>15%破MA10)' };
      }
    }

    if (i === maxIdx) {
      return { exitIdx: i, exitPrice: c.close, exitReason: '安全網30天' };
    }
  }
  return null;
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  A股量價突破策略 v2（+大盤過濾 +移動停損）');
  console.log(`  期間：${BACKTEST_START} ~ ${BACKTEST_END}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

  // 準備股票
  const allStocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, any>)) {
    if (!data.candles || data.candles.length < 100) continue;
    if (data.name.includes('ST')) continue;
    try { allStocks.set(sym, { name: data.name, candles: computeIndicators(data.candles) }); } catch {}
  }
  console.log(`   ${allStocks.size} 支股票`);

  // 大盤指數（上證）
  const benchStock = allStocks.get('000001.SZ') ?? allStocks.get('601318.SS');
  if (!benchStock) { console.error('找不到大盤指數'); return; }

  const tradingDays = benchStock.candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
  console.log(`   ${tradingDays.length} 個交易日\n`);

  const trades: Trade[] = [];
  let holdingUntilIdx = -1;
  let capital = INITIAL_CAPITAL;
  let skipDays = 0;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date = tradingDays[dayIdx];
    if (dayIdx <= holdingUntilIdx) continue;

    // ── 大盤過濾 ──
    const benchIdx = benchStock.candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (benchIdx >= 20) {
      const benchMA20 = getMA(benchStock.candles, benchIdx, 20);
      if (benchStock.candles[benchIdx].close < benchMA20) {
        skipDays++;
        continue; // 大盤在 MA20 以下，停止交易
      }
    }

    const candidates: { symbol: string; name: string; idx: number; candles: CandleWithIndicators[]; entryPrice: number; volRatio: number; dayGain: number; score: number }[] = [];

    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 60 || idx >= candles.length - 2) continue;

      const c = candles[idx];
      const prevClose = candles[idx - 1].close;

      // MA20 > MA60
      const ma20 = getMA(candles, idx, 20);
      const ma60 = getMA(candles, idx, 60);
      if (ma20 <= ma60) continue;
      if (c.close < ma20) continue;

      // 大陽線 >3%
      const dayGain = (c.close - prevClose) / prevClose * 100;
      if (dayGain < MIN_GAIN_PCT) continue;

      // 突破 20 日高
      const high20 = getHighest(candles, idx - 1, BREAKOUT_DAYS);
      if (c.close <= high20) continue;

      // 量比 ≥ 2.0
      const vol = c.volume ?? 0;
      const avgVol20 = getAvgVol(candles, idx, 20);
      const volRatio = avgVol20 > 0 ? vol / avgVol20 : 0;
      if (volRatio < VOL_RATIO_MIN) continue;

      // 連續放量：近 2 日均量 > 5 日均量
      const avgVol2 = getAvgVol(candles, idx, 2);
      const avgVol5 = getAvgVol(candles, idx, 5);
      if (avgVol2 < avgVol5 * 1.2) continue;

      // 不買漲停鎖死
      if (c.open === c.high && c.high === c.close) continue;

      candidates.push({
        symbol, name: stockData.name, idx, candles,
        entryPrice: c.close,
        volRatio: +volRatio.toFixed(2),
        dayGain: +dayGain.toFixed(2),
        score: volRatio * dayGain,
      });
    }

    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[0];

    const result = simulateTrade(pick.candles, pick.idx, pick.entryPrice);
    if (!result) continue;

    const grossReturn = +((result.exitPrice - pick.entryPrice) / pick.entryPrice * 100).toFixed(2);
    const netReturn = +(grossReturn - ROUND_TRIP_COST).toFixed(2);
    const holdDays = result.exitIdx - pick.idx;

    const exitDate = pick.candles[result.exitIdx]?.date?.slice(0, 10) ?? '';
    const exitDayIdx = tradingDays.indexOf(exitDate);
    holdingUntilIdx = exitDayIdx >= 0 ? exitDayIdx : dayIdx + holdDays;

    capital += Math.round(capital * netReturn / 100);

    trades.push({
      entryDate: date, exitDate, symbol: pick.symbol, name: pick.name,
      entryPrice: pick.entryPrice, exitPrice: result.exitPrice,
      netReturn, holdDays, exitReason: result.exitReason,
      volRatio: pick.volRatio, dayGain: pick.dayGain,
    });
  }

  // 輸出
  console.log('  #  買入日      賣出日      股票         名稱      買入     賣出    報酬率   量比  持有  出場原因              帳戶餘額');
  console.log('─'.repeat(115));

  let runCap = INITIAL_CAPITAL;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    runCap += Math.round(runCap * t.netReturn / 100);
    console.log(
      (i+1).toString().padStart(3) + '  ' + t.entryDate + '  ' + t.exitDate + '  ' +
      t.symbol.padEnd(12) + ' ' + t.name.slice(0,6).padEnd(8) +
      t.entryPrice.toFixed(2).padStart(8) + ' ' + t.exitPrice.toFixed(2).padStart(8) + ' ' +
      ((t.netReturn>=0?'+':'')+t.netReturn.toFixed(2)+'%').padStart(8) + ' ' +
      t.volRatio.toFixed(1).padStart(4) + ' ' + (t.holdDays+'天').padStart(4) + '  ' +
      t.exitReason.padEnd(20) + ' ' + runCap.toLocaleString().padStart(11)
    );
  }
  console.log('─'.repeat(115));

  const wins = trades.filter(t => t.netReturn > 0);
  const losses = trades.filter(t => t.netReturn <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s,t)=>s+t.netReturn,0)/wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s,t)=>s+t.netReturn,0)/losses.length : 0;

  console.log('\n初始資金:   ' + INITIAL_CAPITAL.toLocaleString());
  console.log('最終資金:   ' + capital.toLocaleString());
  console.log('總損益:     ' + (capital-INITIAL_CAPITAL>=0?'+':'') + (capital-INITIAL_CAPITAL).toLocaleString());
  console.log('報酬率:     ' + ((capital/INITIAL_CAPITAL-1)*100).toFixed(1) + '%');
  console.log('筆數:       ' + trades.length + '（勝 ' + wins.length + ' / 負 ' + losses.length + '）');
  console.log('勝率:       ' + (trades.length>0?(wins.length/trades.length*100).toFixed(1):'0') + '%');
  console.log('平均獲利:   +' + avgWin.toFixed(2) + '%');
  console.log('平均虧損:   ' + avgLoss.toFixed(2) + '%');
  console.log('盈虧比:     ' + (Math.abs(avgLoss)>0?(avgWin/Math.abs(avgLoss)).toFixed(2):'N/A'));
  console.log('大盤過濾跳過: ' + skipDays + ' 天');

  console.log('\n出場原因:');
  const rc: Record<string,number> = {};
  for (const t of trades) rc[t.exitReason] = (rc[t.exitReason]||0)+1;
  for (const [r,c] of Object.entries(rc).sort((a,b)=>b[1]-a[1]))
    console.log('  ' + r.padEnd(24) + c + '筆');
}

main().catch(console.error);
