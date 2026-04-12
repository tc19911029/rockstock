/**
 * A股新策略回測：
 * 1. 情緒周期擇時 + 打板（打板增強版）
 * 2. 首板低開反包
 * 3. 龍頭首陰反包
 *
 * Usage: npx tsx scripts/backtest-cn-new-strategies.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const BACKTEST_START = '2025-04-01';
const BACKTEST_END   = '2026-04-09';
const INITIAL_CAPITAL = 1000000;
const ROUND_TRIP_COST = 0.16;

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');

interface Trade {
  entryDate: string; exitDate: string;
  symbol: string; name: string;
  entryPrice: number; exitPrice: number;
  netReturn: number; holdDays: number;
  exitReason: string;
}

function getDayReturn(candles: CandleWithIndicators[], idx: number) {
  if (idx <= 0) return 0;
  return (candles[idx].close - candles[idx - 1].close) / candles[idx - 1].close * 100;
}

function getConsecutiveLimitUp(candles: CandleWithIndicators[], idx: number) {
  let count = 0;
  for (let i = idx; i >= 1; i--) {
    if (getDayReturn(candles, i) >= 9.5) count++;
    else break;
  }
  return count;
}

/** 計算當日全市場情緒指標 */
function computeMarketSentiment(
  allStocks: Map<string, { name: string; candles: CandleWithIndicators[] }>,
  date: string
) {
  let limitUpCount = 0;       // 今日漲停家數
  let maxConsecutive = 0;     // 最高連板數
  let limitUpYesterdayAvgReturn = 0; // 昨日漲停股今日平均漲跌
  let limitUpYesterdayCount = 0;

  for (const [, stockData] of allStocks) {
    const candles = stockData.candles;
    const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (idx < 2) continue;

    const todayReturn = getDayReturn(candles, idx);
    const yesterdayReturn = getDayReturn(candles, idx - 1);

    // 今日漲停
    if (todayReturn >= 9.5) {
      limitUpCount++;
      const consecutive = getConsecutiveLimitUp(candles, idx);
      if (consecutive > maxConsecutive) maxConsecutive = consecutive;
    }

    // 昨日漲停股今日表現
    if (yesterdayReturn >= 9.5) {
      limitUpYesterdayCount++;
      limitUpYesterdayAvgReturn += todayReturn;
    }
  }

  if (limitUpYesterdayCount > 0) {
    limitUpYesterdayAvgReturn /= limitUpYesterdayCount;
  }

  return { limitUpCount, maxConsecutive, limitUpYesterdayAvgReturn, limitUpYesterdayCount };
}

function simulateExit(
  candles: CandleWithIndicators[], entryIdx: number, entryPrice: number,
  maxHold: number, tp: number, sl: number
): { exitIdx: number; exitPrice: number; exitReason: string } | null {
  for (let d = 1; d <= maxHold; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) break;
    const c = candles[fi];
    const hr = (c.high - entryPrice) / entryPrice * 100;
    const lr = (c.low - entryPrice) / entryPrice * 100;

    if (hr >= tp) return { exitIdx: fi, exitPrice: +(entryPrice * (1 + tp / 100)).toFixed(2), exitReason: `止盈+${tp}%` };
    if (lr <= sl) return { exitIdx: fi, exitPrice: +(entryPrice * (1 + sl / 100)).toFixed(2), exitReason: `止損${sl}%` };
    if (d === maxHold) return { exitIdx: fi, exitPrice: c.close, exitReason: `持有${maxHold}天` };
    if (d === 1 && c.close < c.open) {
      const ni = fi + 1;
      if (ni < candles.length) return { exitIdx: ni, exitPrice: candles[ni].open, exitReason: '收黑隔日走' };
    }
  }
  return null;
}

function runStrategy(
  name: string,
  allStocks: Map<string, { name: string; candles: CandleWithIndicators[] }>,
  tradingDays: string[],
  pickFn: (date: string, dayIdx: number, sentiment: ReturnType<typeof computeMarketSentiment>) => {
    symbol: string; name: string; idx: number; candles: CandleWithIndicators[];
    entryPrice: number; score: number;
  } | null,
  exitParams: { maxHold: number; tp: number; sl: number }
) {
  const trades: Trade[] = [];
  let holdingUntilIdx = -1;
  let capital = INITIAL_CAPITAL;

  // 預計算情緒
  const sentimentCache = new Map<string, ReturnType<typeof computeMarketSentiment>>();

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    if (dayIdx <= holdingUntilIdx) continue;
    const date = tradingDays[dayIdx];

    if (!sentimentCache.has(date)) {
      sentimentCache.set(date, computeMarketSentiment(allStocks, date));
    }
    const sentiment = sentimentCache.get(date)!;

    const pick = pickFn(date, dayIdx, sentiment);
    if (!pick) continue;

    const result = simulateExit(pick.candles, pick.idx, pick.entryPrice, exitParams.maxHold, exitParams.tp, exitParams.sl);
    if (!result) continue;

    const netRet = +((result.exitPrice - pick.entryPrice) / pick.entryPrice * 100 - ROUND_TRIP_COST).toFixed(2);
    const exitDate = pick.candles[result.exitIdx]?.date?.slice(0, 10) ?? '';
    const edi = tradingDays.indexOf(exitDate);
    holdingUntilIdx = edi >= 0 ? edi : dayIdx + (result.exitIdx - pick.idx);
    capital += Math.round(capital * netRet / 100);

    trades.push({
      entryDate: date, exitDate,
      symbol: pick.symbol, name: pick.name,
      entryPrice: pick.entryPrice, exitPrice: result.exitPrice,
      netReturn: netRet, holdDays: result.exitIdx - pick.idx,
      exitReason: result.exitReason,
    });
  }

  return { name, trades, capital };
}

function printResult(r: { name: string; trades: Trade[]; capital: number }) {
  const wins = r.trades.filter(t => t.netReturn > 0);
  const losses = r.trades.filter(t => t.netReturn <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netReturn, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netReturn, 0) / losses.length : 0;
  const totalReturn = ((r.capital / INITIAL_CAPITAL - 1) * 100).toFixed(1);
  const winRate = r.trades.length > 0 ? (wins.length / r.trades.length * 100).toFixed(1) : '0';
  const avgRet = r.trades.length > 0 ? (r.trades.reduce((s, t) => s + t.netReturn, 0) / r.trades.length).toFixed(2) : '0';
  const pf = Math.abs(losses.reduce((s, t) => s + t.netReturn, 0)) > 0
    ? (wins.reduce((s, t) => s + t.netReturn, 0) / Math.abs(losses.reduce((s, t) => s + t.netReturn, 0))).toFixed(2) : 'N/A';

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${r.name}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  筆數: ${r.trades.length}  勝: ${wins.length}  負: ${losses.length}`);
  console.log(`  勝率: ${winRate}%  均報酬: ${avgRet}%  盈虧比: ${pf}`);
  console.log(`  均勝: +${avgWin.toFixed(2)}%  均負: ${avgLoss.toFixed(2)}%`);
  console.log(`  最終資金: ${r.capital.toLocaleString()}  總報酬: ${totalReturn}%`);

  // 月度
  const months: Record<string, { w: number; l: number; r: number }> = {};
  for (const t of r.trades) {
    const m = t.entryDate.slice(0, 7);
    if (!months[m]) months[m] = { w: 0, l: 0, r: 0 };
    if (t.netReturn > 0) months[m].w++;
    else months[m].l++;
    months[m].r += t.netReturn;
  }
  console.log('\n  月度:');
  for (const [m, s] of Object.entries(months).sort()) {
    console.log(`    ${m}: ${s.w + s.l}筆 勝${s.w}負${s.l} ${(s.r >= 0 ? '+' : '') + s.r.toFixed(1)}%`);
  }

  // 最近10筆
  if (r.trades.length > 0) {
    console.log('\n  最近交易:');
    const recent = r.trades.slice(-10);
    for (const t of recent) {
      const mark = t.netReturn > 0 ? '✓' : '✗';
      console.log(`    ${t.entryDate} ${t.symbol.padEnd(10)} ${t.name.slice(0, 6).padEnd(6)} 買${t.entryPrice.toFixed(2).padStart(7)} 賣${t.exitPrice.toFixed(2).padStart(7)} ${(t.netReturn >= 0 ? '+' : '') + t.netReturn.toFixed(2)}% ${t.exitReason} ${mark}`);
    }
  }
}

async function main() {
  console.log('載入資料...');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const allStocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, any>)) {
    if (!data.candles || data.candles.length < 60) continue;
    if (data.name.includes('ST')) continue;
    try { allStocks.set(sym, { name: data.name, candles: computeIndicators(data.candles) }); } catch {}
  }

  const benchStock = allStocks.get('000001.SZ')!;
  const tradingDays = benchStock.candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);

  console.log(`${allStocks.size} 支股票, ${tradingDays.length} 交易日\n`);

  // ═══════════════════════════════════════════════════════════════════
  // 策略 0：基線打板（對照組）
  // ═══════════════════════════════════════════════════════════════════
  const baseline = runStrategy('基線：打板（現行）', allStocks, tradingDays, (date) => {
    const candidates: any[] = [];
    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 2 || idx >= candles.length - 3) continue;
      const today = candles[idx], yesterday = candles[idx - 1], dayBefore = candles[idx - 2];
      const prevDayGain = (yesterday.close - dayBefore.close) / dayBefore.close * 100;
      if (prevDayGain < 9.5) continue;
      const gapUpPct = (today.open - yesterday.close) / yesterday.close * 100;
      if (gapUpPct < 2.0) continue;
      const turnover = (today.volume ?? 0) * today.close;
      if (turnover < 5e6) continue;
      if (today.open === today.high && today.high === today.close) continue;
      if (today.close < yesterday.close) continue;
      const cl = getConsecutiveLimitUp(candles, idx - 1);
      const bb = cl === 1 ? 2.0 : cl === 2 ? 1.5 : 1.0;
      candidates.push({ symbol, name: stockData.name, idx, candles, entryPrice: today.open, score: bb * Math.log10(turnover) });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a: any, b: any) => b.score - a.score);
    return candidates[0];
  }, { maxHold: 2, tp: 5, sl: -3 });

  // ═══════════════════════════════════════════════════════════════════
  // 策略 1：情緒周期 + 打板
  // ═══════════════════════════════════════════════════════════════════
  const sentimentDaban = runStrategy('情緒周期 + 打板', allStocks, tradingDays, (date, _dayIdx, sentiment) => {
    // 冰點過濾：漲停家數 < 30 或 昨日漲停指數 < -2% → 不操作
    if (sentiment.limitUpCount < 30) return null;
    if (sentiment.limitUpYesterdayAvgReturn < -2) return null;

    const candidates: any[] = [];
    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 2 || idx >= candles.length - 3) continue;
      const today = candles[idx], yesterday = candles[idx - 1], dayBefore = candles[idx - 2];
      const prevDayGain = (yesterday.close - dayBefore.close) / dayBefore.close * 100;
      if (prevDayGain < 9.5) continue;
      const gapUpPct = (today.open - yesterday.close) / yesterday.close * 100;
      if (gapUpPct < 2.0) continue;
      const turnover = (today.volume ?? 0) * today.close;
      if (turnover < 5e6) continue;
      if (today.open === today.high && today.high === today.close) continue;
      if (today.close < yesterday.close) continue;
      const cl = getConsecutiveLimitUp(candles, idx - 1);
      const bb = cl === 1 ? 2.0 : cl === 2 ? 1.5 : 1.0;
      candidates.push({ symbol, name: stockData.name, idx, candles, entryPrice: today.open, score: bb * Math.log10(turnover) });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a: any, b: any) => b.score - a.score);
    return candidates[0];
  }, { maxHold: 2, tp: 5, sl: -3 });

  // 寬鬆情緒版
  const sentimentLoose = runStrategy('情緒寬鬆 + 打板（漲停>15家）', allStocks, tradingDays, (date, _dayIdx, sentiment) => {
    if (sentiment.limitUpCount < 15) return null;
    if (sentiment.limitUpYesterdayAvgReturn < -3) return null;

    const candidates: any[] = [];
    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 2 || idx >= candles.length - 3) continue;
      const today = candles[idx], yesterday = candles[idx - 1], dayBefore = candles[idx - 2];
      const prevDayGain = (yesterday.close - dayBefore.close) / dayBefore.close * 100;
      if (prevDayGain < 9.5) continue;
      const gapUpPct = (today.open - yesterday.close) / yesterday.close * 100;
      if (gapUpPct < 2.0) continue;
      const turnover = (today.volume ?? 0) * today.close;
      if (turnover < 5e6) continue;
      if (today.open === today.high && today.high === today.close) continue;
      if (today.close < yesterday.close) continue;
      const cl = getConsecutiveLimitUp(candles, idx - 1);
      const bb = cl === 1 ? 2.0 : cl === 2 ? 1.5 : 1.0;
      candidates.push({ symbol, name: stockData.name, idx, candles, entryPrice: today.open, score: bb * Math.log10(turnover) });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a: any, b: any) => b.score - a.score);
    return candidates[0];
  }, { maxHold: 2, tp: 5, sl: -3 });

  // ═══════════════════════════════════════════════════════════════════
  // 策略 2：首板低開反包
  // ═══════════════════════════════════════════════════════════════════
  const gapDownReversal = runStrategy('首板低開反包', allStocks, tradingDays, (date) => {
    const candidates: any[] = [];
    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 3 || idx >= candles.length - 3) continue;
      const today = candles[idx], yesterday = candles[idx - 1], dayBefore = candles[idx - 2];

      // 昨日漲停（首板 — 前天不是漲停）
      const prevDayGain = (yesterday.close - dayBefore.close) / dayBefore.close * 100;
      if (prevDayGain < 9.5) continue;
      const twoDaysAgoGain = idx >= 3 ? getDayReturn(candles, idx - 2) : 0;
      if (twoDaysAgoGain >= 9.5) continue; // 排除連板，只要首板

      // 今日低開（開盤 < 昨收）
      const gapPct = (today.open - yesterday.close) / yesterday.close * 100;
      if (gapPct >= 0) continue; // 必須低開
      if (gapPct < -5) continue; // 太大的跳空不要

      // 成交額門檻
      const turnover = (today.volume ?? 0) * today.close;
      if (turnover < 5e6) continue;

      // 不買一字跌停
      if (today.open === today.low && today.low === today.close) continue;

      // 排序：成交額大優先
      candidates.push({
        symbol, name: stockData.name, idx, candles,
        entryPrice: today.open,
        score: Math.log10(turnover),
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a: any, b: any) => b.score - a.score);
    return candidates[0];
  }, { maxHold: 2, tp: 5, sl: -3 });

  // 首板低開反包 — 放寬版（低開或平開都算）
  const gapDownLoose = runStrategy('首板低開/平開反包（gap<2%）', allStocks, tradingDays, (date) => {
    const candidates: any[] = [];
    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 3 || idx >= candles.length - 3) continue;
      const today = candles[idx], yesterday = candles[idx - 1], dayBefore = candles[idx - 2];

      const prevDayGain = (yesterday.close - dayBefore.close) / dayBefore.close * 100;
      if (prevDayGain < 9.5) continue;
      const twoDaysAgoGain = idx >= 3 ? getDayReturn(candles, idx - 2) : 0;
      if (twoDaysAgoGain >= 9.5) continue;

      // 低開或小幅高開（< 2%，排除打板的高開 ≥ 2%）
      const gapPct = (today.open - yesterday.close) / yesterday.close * 100;
      if (gapPct >= 2.0) continue; // 排除高開（打板已覆蓋）
      if (gapPct < -5) continue;

      const turnover = (today.volume ?? 0) * today.close;
      if (turnover < 5e6) continue;
      if (today.open === today.low && today.low === today.close) continue;

      candidates.push({
        symbol, name: stockData.name, idx, candles,
        entryPrice: today.open,
        score: Math.log10(turnover),
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a: any, b: any) => b.score - a.score);
    return candidates[0];
  }, { maxHold: 2, tp: 5, sl: -3 });

  // ═══════════════════════════════════════════════════════════════════
  // 策略 3：龍頭首陰反包
  // ═══════════════════════════════════════════════════════════════════
  const firstDecline = runStrategy('龍頭首陰反包', allStocks, tradingDays, (date) => {
    const candidates: any[] = [];
    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 10 || idx >= candles.length - 4) continue;
      const today = candles[idx], yesterday = candles[idx - 1];

      // 昨日收陰（首陰）— close < open
      if (yesterday.close >= yesterday.open) continue;

      // 前面要有漲停歷史（近10天內有至少2天漲停）
      let limitUpDays = 0;
      let maxConsec = 0;
      let curConsec = 0;
      for (let i = idx - 10; i < idx - 1; i++) {
        if (i < 1) continue;
        if (getDayReturn(candles, i) >= 9.5) {
          limitUpDays++;
          curConsec++;
          if (curConsec > maxConsec) maxConsec = curConsec;
        } else {
          curConsec = 0;
        }
      }
      if (limitUpDays < 2) continue;
      if (maxConsec < 2) continue; // 至少連板2天（確認龍頭）

      // 前天不是陰線（確認是「首」陰）
      const dayBefore = candles[idx - 2];
      if (dayBefore.close < dayBefore.open) continue; // 前天也是陰線 → 不是首陰

      // 今日縮量（量 < 昨日的 80%）
      if (today.volume >= yesterday.volume * 0.8) continue;

      // 成交額門檻
      const turnover = (today.volume ?? 0) * today.close;
      if (turnover < 5e6) continue;

      // 排序：連板數越高越龍頭
      candidates.push({
        symbol, name: stockData.name, idx, candles,
        entryPrice: today.close, // 收盤買入
        score: maxConsec * 10 + Math.log10(turnover),
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a: any, b: any) => b.score - a.score);
    return candidates[0];
  }, { maxHold: 3, tp: 5, sl: -3 });

  // ═══════════════════════════════════════════════════════════════════
  // 輸出所有結果
  // ═══════════════════════════════════════════════════════════════════
  const allResults = [baseline, sentimentDaban, sentimentLoose, gapDownReversal, gapDownLoose, firstDecline];
  for (const r of allResults) printResult(r);

  // 比較表
  console.log('\n\n' + '═'.repeat(90));
  console.log('  策略比較表');
  console.log('═'.repeat(90));
  console.log('策略'.padEnd(30) + '筆數'.padStart(5) + '  勝率'.padStart(6) + '  均報酬'.padStart(8) + '  總報酬'.padStart(10) + '  最終資金'.padStart(14));
  console.log('─'.repeat(90));

  allResults.sort((a, b) => b.capital - a.capital);
  for (const r of allResults) {
    const wins = r.trades.filter(t => t.netReturn > 0);
    const wr = r.trades.length > 0 ? (wins.length / r.trades.length * 100).toFixed(1) : '0';
    const avg = r.trades.length > 0 ? (r.trades.reduce((s, t) => s + t.netReturn, 0) / r.trades.length).toFixed(2) : '0';
    const total = ((r.capital / INITIAL_CAPITAL - 1) * 100).toFixed(1);
    console.log(
      r.name.padEnd(30) + r.trades.length.toString().padStart(5) + '  ' +
      (wr + '%').padStart(6) + '  ' + (avg + '%').padStart(8) + '  ' +
      (total + '%').padStart(10) + '  ' + r.capital.toLocaleString().padStart(14)
    );
  }
  console.log('─'.repeat(90));
}

main().catch(console.error);
