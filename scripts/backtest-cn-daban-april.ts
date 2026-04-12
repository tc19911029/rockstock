/**
 * 打板回測 — 3月底~4月（放寬尾端限制，允許部分持有）
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const LIMIT_UP_PCT = 9.5;
const GAP_UP_MIN = 2.0;
const MIN_TURNOVER = 5e6;
const TAKE_PROFIT_PCT = 5;
const STOP_LOSS_PCT = -3;
const MAX_HOLD_DAYS = 2;
const ROUND_TRIP_COST = 0.16;

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');

function getDayReturn(candles: CandleWithIndicators[], idx: number) {
  if (idx <= 0) return 0;
  return (candles[idx].close - candles[idx - 1].close) / candles[idx - 1].close * 100;
}

function getConsecutiveLimitUp(candles: CandleWithIndicators[], idx: number) {
  let count = 0;
  for (let i = idx; i >= 1; i--) {
    if (getDayReturn(candles, i) >= LIMIT_UP_PCT) count++;
    else break;
  }
  return count;
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
  if (!benchStock) return;

  const tradingDays = benchStock.candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= '2026-03-25' && d <= '2026-04-10');

  console.log('交易日:', tradingDays);
  console.log('');

  let holdingUntilIdx = -1;
  let capital = 1000000;
  let tradeNum = 0, wins = 0;

  console.log('  #  買入日      賣出日      股票         名稱      昨漲    高開   買入     賣出    報酬率   出場原因         累計報酬');
  console.log('─'.repeat(110));

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    if (dayIdx <= holdingUntilIdx) continue;
    const date = tradingDays[dayIdx];

    const candidates: any[] = [];
    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 2) continue;
      // 放寬：只要還有至少1天的資料就可以（不再要求 MAX_HOLD_DAYS+1）
      if (idx >= candles.length - 1) continue;

      const today = candles[idx], yesterday = candles[idx - 1], dayBefore = candles[idx - 2];
      const prevDayGain = (yesterday.close - dayBefore.close) / dayBefore.close * 100;
      if (prevDayGain < LIMIT_UP_PCT) continue;
      const gapUpPct = (today.open - yesterday.close) / yesterday.close * 100;
      if (gapUpPct < GAP_UP_MIN) continue;
      const turnover = (today.volume ?? 0) * today.close;
      if (turnover < MIN_TURNOVER) continue;
      if (today.open === today.high && today.high === today.close) continue;
      if (today.close < yesterday.close) continue;
      const consecutiveLimits = getConsecutiveLimitUp(candles, idx - 1);
      const boardBonus = consecutiveLimits === 1 ? 2.0 : consecutiveLimits === 2 ? 1.5 : 1.0;
      candidates.push({
        symbol, name: stockData.name, idx, candles, entryPrice: today.open,
        prevDayGain: +prevDayGain.toFixed(2), gapUpPct: +gapUpPct.toFixed(2),
        consecutiveLimits, turnover, score: boardBonus * Math.log10(turnover),
      });
    }
    if (candidates.length === 0) {
      console.log('     ' + date + ': 無候選（' + (() => {
        // 快速統計原因
        let limitUp = 0, gapUp = 0;
        for (const [, sd] of allStocks) {
          const idx2 = sd.candles.findIndex(c => c.date?.slice(0,10) === date);
          if (idx2 < 2 || idx2 >= sd.candles.length - 1) continue;
          const pg = (sd.candles[idx2-1].close - sd.candles[idx2-2].close) / sd.candles[idx2-2].close * 100;
          if (pg >= LIMIT_UP_PCT) { limitUp++; const g = (sd.candles[idx2].open - sd.candles[idx2-1].close)/sd.candles[idx2-1].close*100; if(g>=2) gapUp++; }
        }
        return '昨漲停'+limitUp+'支 高開≥2%有'+gapUp+'支';
      })() + '）');
      continue;
    }
    candidates.sort((a: any, b: any) => b.score - a.score);
    const pick = candidates[0];

    const candles = pick.candles;
    const entryIdx = pick.idx;
    let exitIdx = entryIdx, exitPrice = pick.entryPrice, exitReason = '';

    // 放寬持有邏輯：有多少天就看多少天
    const maxDays = Math.min(MAX_HOLD_DAYS, candles.length - 1 - entryIdx);
    for (let d = 1; d <= maxDays; d++) {
      const fi = entryIdx + d;
      const c = candles[fi];
      const hr = (c.high - pick.entryPrice) / pick.entryPrice * 100;
      const lr = (c.low - pick.entryPrice) / pick.entryPrice * 100;
      if (hr >= TAKE_PROFIT_PCT) { exitIdx = fi; exitPrice = +(pick.entryPrice * 1.05).toFixed(2); exitReason = '止盈+5%'; break; }
      if (lr <= STOP_LOSS_PCT) { exitIdx = fi; exitPrice = +(pick.entryPrice * 0.97).toFixed(2); exitReason = '止損-3%'; break; }
      if (d === maxDays) { exitIdx = fi; exitPrice = c.close; exitReason = d < MAX_HOLD_DAYS ? '資料截止收盤' : '持有2天'; break; }
      if (d === 1 && c.close < c.open) {
        const ni = fi + 1;
        if (ni < candles.length) { exitIdx = ni; exitPrice = candles[ni].open; exitReason = '收黑隔日走'; break; }
        else { exitIdx = fi; exitPrice = c.close; exitReason = '收黑(資料截止)'; break; }
      }
    }
    if (exitIdx === entryIdx) continue;

    const netRet = +((exitPrice - pick.entryPrice) / pick.entryPrice * 100 - ROUND_TRIP_COST).toFixed(2);
    const holdDays = exitIdx - entryIdx;
    const exitDate = candles[exitIdx]?.date?.slice(0, 10) ?? '';
    const edi = tradingDays.indexOf(exitDate);
    holdingUntilIdx = edi >= 0 ? edi : dayIdx + holdDays;
    capital += Math.round(capital * netRet / 100);

    tradeNum++;
    if (netRet > 0) wins++;

    const cumRet = ((capital / 1000000 - 1) * 100).toFixed(1);
    const marker = netRet > 0 ? ' ✓' : ' ✗';
    console.log(
      tradeNum.toString().padStart(3) + '  ' + date + '  ' + exitDate + '  ' +
      pick.symbol.padEnd(12) + ' ' + pick.name.slice(0, 6).padEnd(8) +
      ('+' + pick.prevDayGain.toFixed(1) + '%').padStart(7) + ' ' +
      ('+' + pick.gapUpPct.toFixed(1) + '%').padStart(6) + ' ' +
      pick.entryPrice.toFixed(2).padStart(8) + ' ' +
      exitPrice.toFixed(2).padStart(8) + ' ' +
      ((netRet >= 0 ? '+' : '') + netRet.toFixed(2) + '%').padStart(8) + '  ' +
      exitReason.padEnd(14) +
      (cumRet + '%').padStart(8) + marker
    );
  }

  console.log('─'.repeat(110));
  console.log('');
  console.log('統計: ' + tradeNum + '筆  勝' + wins + '負' + (tradeNum - wins) + '  勝率' + (tradeNum > 0 ? (wins / tradeNum * 100).toFixed(1) : '0') + '%  累計' + ((capital / 1000000 - 1) * 100).toFixed(1) + '%');
}

main().catch(console.error);
