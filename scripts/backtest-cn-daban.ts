/**
 * A股打板戰法回測
 *
 * 核心邏輯：買昨日漲停的股票，隔日沖高賣出
 *
 * 進場：昨日漲停（漲幅≥9.5%）+ 今日高開≥2% + 量能放大
 * 出場：當日收盤賣（T+1 限制）
 *       獲利≥5% 或 虧損≥-3% 以收盤價出場
 *       最多持有 2 天
 * 排序：昨日封板力度（成交額）× 連板天數
 * 一次只買一檔
 *
 * Usage: npx tsx scripts/backtest-cn-daban.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const BACKTEST_START = '2025-04-01';
const BACKTEST_END   = '2026-04-04';
const INITIAL_CAPITAL = 1000000;

// 進場參數
const LIMIT_UP_PCT     = 9.5;   // 漲停判定（≥9.5%視為漲停）
const GAP_UP_MIN       = 2.0;   // 今日高開最低%
const MIN_TURNOVER     = 5e6;   // 最低成交額（500萬）
const MIN_MARKET_CAP   = 2e9;   // 最低市值（20億）— 用收盤價×股本估算

// 出場參數
const TAKE_PROFIT_PCT  = 5;     // 止盈%
const STOP_LOSS_PCT    = -3;    // 止損%
const MAX_HOLD_DAYS    = 2;     // 最多持有天數

// 費用
const ROUND_TRIP_COST  = 0.16;

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');

interface Trade {
  entryDate: string; exitDate: string;
  symbol: string; name: string;
  entryPrice: number; exitPrice: number;
  netReturn: number; holdDays: number;
  exitReason: string;
  prevDayGain: number;   // 昨日漲幅
  gapUpPct: number;      // 今日高開幅度
  consecutiveLimits: number; // 連板天數
}

function getDayReturn(candles: CandleWithIndicators[], idx: number): number {
  if (idx <= 0) return 0;
  return (candles[idx].close - candles[idx - 1].close) / candles[idx - 1].close * 100;
}

function getConsecutiveLimitUp(candles: CandleWithIndicators[], idx: number): number {
  let count = 0;
  for (let i = idx; i >= 1; i--) {
    const ret = getDayReturn(candles, i);
    if (ret >= LIMIT_UP_PCT) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  A股打板戰法回測');
  console.log('  買入：昨日漲停 + 今日高開≥2%');
  console.log('  賣出：止盈+5% / 止損-3% / 最多持有2天');
  console.log(`  期間：${BACKTEST_START} ~ ${BACKTEST_END}`);
  console.log('  一次只買一檔，真實資金流');
  console.log('═══════════════════════════════════════════════════════════\n');

  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

  const allStocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, any>)) {
    if (!data.candles || data.candles.length < 60) continue;
    if (data.name.includes('ST')) continue;
    try { allStocks.set(sym, { name: data.name, candles: computeIndicators(data.candles) }); } catch {}
  }
  console.log(`   ${allStocks.size} 支股票`);

  // 取得交易日
  const benchStock = allStocks.get('000001.SZ') ?? allStocks.get('601318.SS');
  if (!benchStock) { console.error('找不到基準'); return; }
  const tradingDays = benchStock.candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
  console.log(`   ${tradingDays.length} 個交易日\n`);

  const trades: Trade[] = [];
  let holdingUntilIdx = -1;
  let capital = INITIAL_CAPITAL;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date = tradingDays[dayIdx];
    if (dayIdx <= holdingUntilIdx) continue;

    interface Candidate {
      symbol: string; name: string; idx: number;
      candles: CandleWithIndicators[];
      entryPrice: number;
      prevDayGain: number; gapUpPct: number;
      consecutiveLimits: number; score: number;
      turnover: number;
    }
    const candidates: Candidate[] = [];

    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 2 || idx >= candles.length - MAX_HOLD_DAYS) continue;

      const today = candles[idx];
      const yesterday = candles[idx - 1];
      const dayBefore = candles[idx - 2];

      // ── 條件1：昨日漲停（≥9.5%）──
      const prevDayGain = (yesterday.close - dayBefore.close) / dayBefore.close * 100;
      if (prevDayGain < LIMIT_UP_PCT) continue;

      // ── 條件2：今日高開 ≥ 2% ──
      const gapUpPct = (today.open - yesterday.close) / yesterday.close * 100;
      if (gapUpPct < GAP_UP_MIN) continue;

      // ── 條件3：成交額門檻 ──
      const turnover = (today.volume ?? 0) * today.close;
      if (turnover < MIN_TURNOVER) continue;

      // ── 條件4：不買一字板（開盤=最高=收盤=漲停，散戶買不到）──
      if (today.open === today.high && today.high === today.close) continue;

      // ── 條件5：不買跌停開（開盤就跌回去的假高開）──
      if (today.close < yesterday.close) continue;

      // 連板天數
      const consecutiveLimits = getConsecutiveLimitUp(candles, idx - 1);

      // 排序：首板優先（連板越少越安全）+ 成交額大
      // 首板 score 高，連板 score 遞減
      const boardBonus = consecutiveLimits === 1 ? 2.0 : consecutiveLimits === 2 ? 1.5 : 1.0;
      const score = boardBonus * Math.log10(turnover);

      candidates.push({
        symbol, name: stockData.name, idx, candles,
        entryPrice: today.open,  // 開盤價買入
        prevDayGain: +prevDayGain.toFixed(2),
        gapUpPct: +gapUpPct.toFixed(2),
        consecutiveLimits,
        score,
        turnover,
      });
    }

    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[0];

    // ── 模擬交易（T+1：今天買，最早明天賣）──
    const candles = pick.candles;
    const entryIdx = pick.idx;
    let exitIdx = entryIdx;
    let exitPrice = pick.entryPrice;
    let exitReason = '';

    for (let d = 1; d <= MAX_HOLD_DAYS; d++) {
      const futureIdx = entryIdx + d;
      if (futureIdx >= candles.length) break;

      const c = candles[futureIdx];
      const currentReturn = (c.close - pick.entryPrice) / pick.entryPrice * 100;
      const highReturn = (c.high - pick.entryPrice) / pick.entryPrice * 100;
      const lowReturn = (c.low - pick.entryPrice) / pick.entryPrice * 100;

      // 止盈：日內最高觸及 +5%
      if (highReturn >= TAKE_PROFIT_PCT) {
        exitIdx = futureIdx;
        exitPrice = +(pick.entryPrice * (1 + TAKE_PROFIT_PCT / 100)).toFixed(2);
        exitReason = '止盈+5%';
        break;
      }

      // 止損：日內最低觸及 -3%
      if (lowReturn <= STOP_LOSS_PCT) {
        exitIdx = futureIdx;
        exitPrice = +(pick.entryPrice * (1 + STOP_LOSS_PCT / 100)).toFixed(2);
        exitReason = '止損-3%';
        break;
      }

      // 持有到期：用收盤價出場
      if (d === MAX_HOLD_DAYS) {
        exitIdx = futureIdx;
        exitPrice = c.close;
        exitReason = '持有2天收盤';
        break;
      }

      // 第一天收盤判斷：如果收紅就繼續持有，收黑就明天開盤走人
      if (d === 1 && c.close < c.open) {
        // 收黑K → 明天開盤走
        const nextIdx = futureIdx + 1;
        if (nextIdx < candles.length) {
          exitIdx = nextIdx;
          exitPrice = candles[nextIdx].open;
          exitReason = '收黑隔日開盤走';
          break;
        }
      }
    }

    if (exitIdx === entryIdx) continue;

    const grossReturn = +((exitPrice - pick.entryPrice) / pick.entryPrice * 100).toFixed(2);
    const netReturn = +(grossReturn - ROUND_TRIP_COST).toFixed(2);
    const holdDays = exitIdx - entryIdx;

    const exitDate = candles[exitIdx]?.date?.slice(0, 10) ?? '';
    const exitDayIdx = tradingDays.indexOf(exitDate);
    holdingUntilIdx = exitDayIdx >= 0 ? exitDayIdx : dayIdx + holdDays;

    capital += Math.round(capital * netReturn / 100);

    trades.push({
      entryDate: date, exitDate,
      symbol: pick.symbol, name: pick.name,
      entryPrice: pick.entryPrice, exitPrice,
      netReturn, holdDays,
      exitReason,
      prevDayGain: pick.prevDayGain,
      gapUpPct: pick.gapUpPct,
      consecutiveLimits: pick.consecutiveLimits,
    });
  }

  // 輸出
  console.log('  #  買入日      賣出日      股票         名稱      昨漲    高開   連板  買入     賣出    報酬率   持有  出場原因          帳戶餘額');
  console.log('─'.repeat(125));

  let runCap = INITIAL_CAPITAL;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    runCap += Math.round(runCap * t.netReturn / 100);
    console.log(
      (i+1).toString().padStart(3) + '  ' +
      t.entryDate + '  ' + t.exitDate + '  ' +
      t.symbol.padEnd(12) + ' ' + t.name.slice(0,6).padEnd(8) +
      ('+'+t.prevDayGain.toFixed(1)+'%').padStart(7) + ' ' +
      ('+'+t.gapUpPct.toFixed(1)+'%').padStart(6) + ' ' +
      (t.consecutiveLimits+'板').padStart(4) + ' ' +
      t.entryPrice.toFixed(2).padStart(8) + ' ' +
      t.exitPrice.toFixed(2).padStart(8) + ' ' +
      ((t.netReturn>=0?'+':'')+t.netReturn.toFixed(2)+'%').padStart(8) + ' ' +
      (t.holdDays+'天').padStart(3) + '  ' +
      t.exitReason.padEnd(16) + ' ' +
      runCap.toLocaleString().padStart(11)
    );
  }
  console.log('─'.repeat(125));

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
  console.log('平均每筆:   ' + (trades.length>0?((trades.reduce((s,t)=>s+t.netReturn,0)/trades.length).toFixed(2)):'0') + '%');
  console.log('平均獲利:   +' + avgWin.toFixed(2) + '%');
  console.log('平均虧損:   ' + avgLoss.toFixed(2) + '%');
  console.log('盈虧比:     ' + (Math.abs(avgLoss)>0?(avgWin/Math.abs(avgLoss)).toFixed(2):'N/A'));
  console.log('平均持有:   ' + (trades.length>0?(trades.reduce((s,t)=>s+t.holdDays,0)/trades.length).toFixed(1):'0') + '天');

  // 首板 vs 連板分析
  console.log('\n連板分析:');
  for (let b = 1; b <= 4; b++) {
    const group = trades.filter(t => t.consecutiveLimits === b);
    if (group.length === 0) continue;
    const avg = group.reduce((s,t)=>s+t.netReturn,0)/group.length;
    const wr = group.filter(t=>t.netReturn>0).length/group.length*100;
    console.log(`  ${b}板: ${group.length}筆  均報:${(avg>=0?'+':'')+avg.toFixed(2)}%  勝率:${wr.toFixed(0)}%`);
  }

  console.log('\n出場原因:');
  const rc: Record<string,number> = {};
  for (const t of trades) rc[t.exitReason] = (rc[t.exitReason]||0)+1;
  for (const [r,c] of Object.entries(rc).sort((a,b)=>b[1]-a[1]))
    console.log('  ' + r.padEnd(20) + c + '筆 (' + (c/trades.length*100).toFixed(0) + '%)');
}

main().catch(console.error);
