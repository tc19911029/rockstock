/**
 * A股量價突破策略回測
 *
 * 進場：放量突破20日高點 + MA20>MA60 + 大陽線
 * 出場：停損-8% / 獲利>15%跌破MA10 / 安全網30天
 * 排序：量比×突破力度
 * 一次只買一檔，真實資金流
 *
 * Usage: npx tsx scripts/backtest-cn-breakout.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const BACKTEST_START = '2025-04-01';
const BACKTEST_END   = '2026-04-04';
const INITIAL_CAPITAL = 1000000;

// 進場參數
const VOL_RATIO_MIN    = 1.5;   // 量比最低門檻
const BREAKOUT_DAYS    = 20;    // 突破N日高點
const MIN_GAIN_PCT     = 3;     // 當日最低漲幅%（大陽線）

// 出場參數
const STOP_LOSS_PCT    = -8;    // 停損%
const TAKE_PROFIT_PCT  = 15;    // 停利啟動門檻%
const MAX_HOLD_DAYS    = 30;    // 最大持有天數

// 費用（A股：佣金0.03%×2 + 印花稅0.1%）
const ROUND_TRIP_COST  = 0.03 * 2 + 0.1; // = 0.16%

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');

interface StockData {
  name: string;
  candles: CandleWithIndicators[];
}

interface Trade {
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
  volRatio: number;
  dayGain: number;
}

interface Candidate {
  symbol: string;
  name: string;
  idx: number;
  candles: CandleWithIndicators[];
  entryPrice: number;
  volRatio: number;
  dayGain: number;
  score: number;
}

function getMA(candles: CandleWithIndicators[], idx: number, period: number): number {
  let sum = 0;
  const start = Math.max(0, idx - period + 1);
  for (let i = start; i <= idx; i++) sum += candles[i].close;
  return sum / (idx - start + 1);
}

function getHighest(candles: CandleWithIndicators[], idx: number, period: number): number {
  let max = -Infinity;
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++) {
    if (candles[i].high > max) max = candles[i].high;
  }
  return max;
}

function getAvgVolume(candles: CandleWithIndicators[], idx: number, period: number): number {
  let sum = 0;
  const start = Math.max(0, idx - period + 1);
  for (let i = start; i <= idx; i++) sum += (candles[i].volume ?? 0);
  return sum / (idx - start + 1);
}

/**
 * 模擬單筆交易出場
 */
function simulateTrade(candles: CandleWithIndicators[], entryIdx: number, entryPrice: number): {
  exitIdx: number; exitPrice: number; exitReason: string;
} | null {
  const maxIdx = Math.min(entryIdx + MAX_HOLD_DAYS, candles.length - 1);

  let peakPrice = entryPrice;

  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const c = candles[i];
    const currentReturn = (c.close - entryPrice) / entryPrice * 100;

    if (c.close > peakPrice) peakPrice = c.close;

    // 停損：跌破 -8%
    if (c.low <= entryPrice * (1 + STOP_LOSS_PCT / 100)) {
      const exitPrice = +(entryPrice * (1 + STOP_LOSS_PCT / 100)).toFixed(2);
      return { exitIdx: i, exitPrice, exitReason: '停損-8%' };
    }

    // 停利：獲利 >15% 且跌破 MA10
    if (currentReturn > TAKE_PROFIT_PCT) {
      const ma10 = getMA(candles, i, 10);
      if (c.close < ma10) {
        return { exitIdx: i, exitPrice: c.close, exitReason: '停利(>15%破MA10)' };
      }
    }

    // 安全網
    if (i === maxIdx) {
      return { exitIdx: i, exitPrice: c.close, exitReason: '安全網30天' };
    }
  }

  return null;
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  A股量價突破策略回測');
  console.log('  進場：放量突破20日高 + MA20>MA60 + 大陽線(>3%)');
  console.log('  出場：停損-8% / 獲利>15%破MA10 / 安全網30天');
  console.log('  排序：量比 × 突破力度');
  console.log(`  期間：${BACKTEST_START} ~ ${BACKTEST_END}`);
  console.log('  一次只買一檔，真實資金流');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!fs.existsSync(cacheFile)) {
    console.error('❌ 找不到快取', cacheFile);
    return;
  }

  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  console.log(`   快取時間: ${raw.savedAt}`);

  // 準備股票資料
  const allStocks = new Map<string, StockData>();
  for (const [symbol, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: any[] }>)) {
    if (!data.candles || data.candles.length < 100) continue;
    // 排除 ST 股
    if (data.name.includes('ST') || data.name.includes('*ST')) continue;

    try {
      const candles = computeIndicators(data.candles);
      allStocks.set(symbol, { name: data.name, candles });
    } catch { /* skip */ }
  }
  console.log(`   ${allStocks.size} 支股票\n`);

  // 取得交易日（用上證指數的日期）
  const benchSymbols = ['600519.SS', '601318.SS', '000001.SZ'];
  let tradingDays: string[] = [];
  for (const sym of benchSymbols) {
    const stock = allStocks.get(sym);
    if (stock) {
      tradingDays = stock.candles
        .map(c => c.date?.slice(0, 10))
        .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
      break;
    }
  }
  console.log(`   ${tradingDays.length} 個交易日\n`);

  // 回測
  const trades: Trade[] = [];
  let holdingUntilIdx = -1;
  let capital = INITIAL_CAPITAL;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date = tradingDays[dayIdx];

    // 還在持有中 → 跳過
    if (dayIdx <= holdingUntilIdx) continue;

    // 掃描所有股票找候選
    const candidates: Candidate[] = [];

    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 60 || idx >= candles.length - 2) continue;

      const c = candles[idx];
      const prevClose = candles[idx - 1].close;

      // ── 進場條件 ──

      // 1. MA20 > MA60（中期趨勢向上）
      const ma20 = getMA(candles, idx, 20);
      const ma60 = getMA(candles, idx, 60);
      if (ma20 <= ma60) continue;

      // 2. 股價站上 MA20
      if (c.close < ma20) continue;

      // 3. 當日漲幅 > 3%（大陽線）
      const dayGain = (c.close - prevClose) / prevClose * 100;
      if (dayGain < MIN_GAIN_PCT) continue;

      // 4. 放量突破 20 日高點
      const high20 = getHighest(candles, idx - 1, BREAKOUT_DAYS); // 前20日（不含今天）
      if (c.close <= high20) continue; // 沒突破

      const vol = c.volume ?? 0;
      const avgVol20 = getAvgVolume(candles, idx, 20);
      const volRatio = avgVol20 > 0 ? vol / avgVol20 : 0;
      if (volRatio < VOL_RATIO_MIN) continue; // 量不夠

      // 5. 不買漲停鎖死（開盤=最高=收盤）
      if (c.open === c.high && c.high === c.close && c.high > c.low) continue;

      // 排序分數：量比 × 突破力度
      const score = volRatio * dayGain;

      candidates.push({
        symbol, name: stockData.name,
        idx, candles,
        entryPrice: c.close,
        volRatio: +volRatio.toFixed(2),
        dayGain: +dayGain.toFixed(2),
        score,
      });
    }

    if (candidates.length === 0) continue;

    // 排序取第一名
    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[0];

    // 模擬交易
    const result = simulateTrade(pick.candles, pick.idx, pick.entryPrice);
    if (!result) continue;

    const grossReturn = +((result.exitPrice - pick.entryPrice) / pick.entryPrice * 100).toFixed(2);
    const netReturn = +(grossReturn - ROUND_TRIP_COST).toFixed(2);
    const holdDays = result.exitIdx - pick.idx;

    // 標記持有期間
    const exitDate = pick.candles[result.exitIdx]?.date?.slice(0, 10) ?? '';
    // 找 exitDate 在 tradingDays 中的位置
    const exitDayIdx = tradingDays.indexOf(exitDate);
    holdingUntilIdx = exitDayIdx >= 0 ? exitDayIdx : dayIdx + holdDays;

    const gain = Math.round(capital * netReturn / 100);
    capital += gain;

    trades.push({
      entryDate: date,
      exitDate,
      symbol: pick.symbol,
      name: pick.name,
      entryPrice: pick.entryPrice,
      exitPrice: result.exitPrice,
      grossReturn,
      netReturn,
      holdDays,
      exitReason: result.exitReason,
      volRatio: pick.volRatio,
      dayGain: pick.dayGain,
    });
  }

  // 輸出結果
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  交易明細（初始資金 100 萬，已扣佣金+印花稅）');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('  #  買入日      賣出日      股票         名稱      買入     賣出    報酬率    量比  漲幅  持有  出場原因          帳戶餘額');
  console.log('─'.repeat(120));

  let runCap = INITIAL_CAPITAL;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const gain = Math.round(runCap * t.netReturn / 100);
    runCap += gain;
    const retStr = (t.netReturn >= 0 ? '+' : '') + t.netReturn.toFixed(2) + '%';
    console.log(
      (i + 1).toString().padStart(3) + '  ' +
      t.entryDate + '  ' +
      t.exitDate + '  ' +
      t.symbol.padEnd(12) + ' ' +
      t.name.slice(0, 6).padEnd(8) +
      t.entryPrice.toFixed(2).padStart(8) + ' ' +
      t.exitPrice.toFixed(2).padStart(8) + ' ' +
      retStr.padStart(8) + ' ' +
      t.volRatio.toFixed(1).padStart(5) + ' ' +
      ('+' + t.dayGain.toFixed(1) + '%').padStart(6) + ' ' +
      (t.holdDays + '天').padStart(4) + '  ' +
      t.exitReason.padEnd(16) + ' ' +
      runCap.toLocaleString().padStart(11)
    );
  }

  console.log('─'.repeat(120));

  const wins = trades.filter(t => t.netReturn > 0);
  const losses = trades.filter(t => t.netReturn <= 0);
  const avgReturn = trades.length > 0 ? trades.reduce((s, t) => s + t.netReturn, 0) / trades.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netReturn, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netReturn, 0) / losses.length : 0;

  console.log('');
  console.log('初始資金:   ' + INITIAL_CAPITAL.toLocaleString());
  console.log('最終資金:   ' + capital.toLocaleString());
  console.log('總損益:     ' + (capital - INITIAL_CAPITAL >= 0 ? '+' : '') + (capital - INITIAL_CAPITAL).toLocaleString());
  console.log('報酬率:     ' + ((capital / INITIAL_CAPITAL - 1) * 100).toFixed(1) + '%');
  console.log('筆數:       ' + trades.length + '（勝 ' + wins.length + ' / 負 ' + losses.length + '）');
  console.log('勝率:       ' + (trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0') + '%');
  console.log('平均每筆:   ' + (avgReturn >= 0 ? '+' : '') + avgReturn.toFixed(2) + '%');
  console.log('平均獲利:   +' + avgWin.toFixed(2) + '%');
  console.log('平均虧損:   ' + avgLoss.toFixed(2) + '%');
  console.log('盈虧比:     ' + (Math.abs(avgLoss) > 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : 'N/A'));
  console.log('平均持有:   ' + (trades.length > 0 ? (trades.reduce((s, t) => s + t.holdDays, 0) / trades.length).toFixed(1) : '0') + '天');
  console.log('每月交易:   ' + (trades.length / 12).toFixed(1) + '筆');

  // 出場原因統計
  console.log('\n出場原因統計:');
  const reasonCount: Record<string, number> = {};
  for (const t of trades) {
    reasonCount[t.exitReason] = (reasonCount[t.exitReason] || 0) + 1;
  }
  for (const [reason, count] of Object.entries(reasonCount).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + reason.padEnd(20) + count + '筆 (' + (count / trades.length * 100).toFixed(1) + '%)');
  }
}

main().catch(console.error);
