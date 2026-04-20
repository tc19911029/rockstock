/**
 * 再進場分支 vs Baseline 對照回測
 *
 * 對齊 scripts/backtest-run.ts 的選股+出場邏輯，唯一差別：
 *   - Baseline：每次進場都跑完整六條件
 *   - Re-entry：跌破 MA5/MA10 出場後，趨勢未破 + 站上 MA5 即可用鬆條件再進場
 *
 * 用途：驗證書本「跌破均線出場後容易再進」的邏輯實戰績效是否優於 baseline。
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-reentry-compare.ts
 *
 * 預設跑 TW 1 年。改 CONFIG.market='CN' 或 CONFIG.period 可改範圍。
 */

import fs   from 'fs';
import path from 'path';
import { computeIndicators }          from '@/lib/indicators';
import { evaluateSixConditions }      from '@/lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe }     from '@/lib/analysis/multiTimeframeFilter';
import { evaluateHighWinRateEntry }   from '@/lib/analysis/highWinRateEntry';
import { checkLongProhibitions }      from '@/lib/rules/entryProhibitions';
import { evaluateElimination }        from '@/lib/scanner/eliminationFilter';
import type { CandleWithIndicators }  from '@/types';
import { BASE_THRESHOLDS, ZHU_OPTIMIZED } from '@/lib/strategy/StrategyConfig';
import {
  evaluateReentry,
  buildReentryWindow,
  isReentryWindowActive,
  isTrendIntactSinceWindow,
  type ReentryWindow,
} from '@/lib/backtest/reentryRules';

// ══════════════════════════════════════════════════════════════
// 設定
// ══════════════════════════════════════════════════════════════

const CONFIG = {
  market: (process.env.MARKET ?? 'TW') as 'TW' | 'CN',
  period: { start: '2025-04-19', end: '2026-04-17' },  // 1 年
  capital: 1_000_000,
  topN: 500,
  mtfMin: 0,            // 對齊 daily session
  sortBy: '六條件總分' as const,
} as const;

// ══════════════════════════════════════════════════════════════
// 常數（對齊 backtest-run.ts）
// ══════════════════════════════════════════════════════════════

const SLIPPAGE_PCT  = 0.001;
const TW_COST_PCT   = (0.001425 * 0.6 * 2 + 0.003) * 100;
const CN_COST_PCT   = 0.16;
const MTF_CFG       = { ...BASE_THRESHOLDS, multiTimeframeFilter: true };
const S1_SL_PCT     = -5;
const S1_PROFIT_GATE_PCT = 10;
const S1_MAX_HOLD   = 60;

// 出場原因 → 再進場白名單映射
function classifyExitReason(reason: string): 'ma5StopLoss' | 'ma10StopLoss' | null {
  if (reason.includes('跌破MA5')) return 'ma5StopLoss';
  if (reason.includes('跌破MA10')) return 'ma10StopLoss';
  return null;
}

// ══════════════════════════════════════════════════════════════
// 型別
// ══════════════════════════════════════════════════════════════

interface StockData {
  name: string;
  candles: CandleWithIndicators[];
}

interface SixcondFeatures {
  symbol: string; name: string; idx: number; candles: CandleWithIndicators[];
  entryPrice: number; totalScore: number; changePercent: number;
  highWinRateScore: number; mtfScore: number;
  rankScore: number;
}

interface ExitResult {
  exitIdx: number;
  exitPrice: number;
  exitReason: string;
}

interface Trade {
  no: number;
  entryDate: string;
  exitDate: string;
  symbol: string;
  name: string;
  entryType: 'initial' | 'reentry';
  entryPrice: number;
  exitPrice: number;
  netPct: number;
  pnl: number;
  capitalAfter: number;
  holdDays: number;
  exitReason: string;
}

// ══════════════════════════════════════════════════════════════
// 資料載入（對齊 backtest-run.ts）
// ══════════════════════════════════════════════════════════════

function loadStocks(market: 'TW' | 'CN'): Map<string, StockData> {
  const stocks = new Map<string, StockData>();

  if (market === 'TW') {
    const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
    if (!fs.existsSync(dir)) { console.error('TW candles 目錄不存在'); return stocks; }
    process.stdout.write('  讀取TW K線...');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
        if (!c || c.length < 60) continue;
        stocks.set(f.replace('.json', ''), {
          name: (raw as { name?: string }).name ?? f.replace('.json', ''),
          candles: computeIndicators(c),
        });
      } catch { /* 略 */ }
    }
    console.log(` ${stocks.size} 支`);
    return stocks;
  }

  const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');
  if (fs.existsSync(cacheFile)) {
    process.stdout.write('  讀取CN bulk cache...');
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    let n = 0;
    for (const [sym, d] of Object.entries(raw.stocks as Record<string, { name: string; candles: unknown[] }>)) {
      if (!d.candles || d.candles.length < 60 || d.name.includes('ST')) continue;
      try {
        stocks.set(sym, { name: d.name, candles: computeIndicators(d.candles as CandleWithIndicators[]) });
        n++;
      } catch { /* 略 */ }
    }
    console.log(` ${n} 支`);
  }
  return stocks;
}

// ══════════════════════════════════════════════════════════════
// 選股 + 出場邏輯（對齊 backtest-run.ts S1）
// ══════════════════════════════════════════════════════════════

function buildTopNSet(allStocks: Map<string, StockData>, date: string, topN: number): Set<string> | null {
  if (!topN) return null;
  const list: { symbol: string; avg: number }[] = [];
  for (const [symbol, sd] of allStocks) {
    const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (idx < 1) continue;
    let total = 0, cnt = 0;
    for (let i = Math.max(0, idx - 20); i < idx; i++) {
      total += sd.candles[i].volume * sd.candles[i].close;
      cnt++;
    }
    list.push({ symbol, avg: cnt > 0 ? total / cnt : 0 });
  }
  list.sort((a, b) => b.avg - a.avg);
  return new Set(list.slice(0, topN).map(d => d.symbol));
}

function buildInitialCandidate(
  symbol: string, name: string,
  candles: CandleWithIndicators[], idx: number,
  mtfMin: number,
): SixcondFeatures | null {
  if (idx < 60 || idx + 2 >= candles.length) return null;

  const six = evaluateSixConditions(candles, idx, ZHU_OPTIMIZED.thresholds);
  if (!six.isCoreReady || six.totalScore < 5) return null;
  if (checkLongProhibitions(candles, idx).prohibited) return null;
  if (evaluateElimination(candles, idx).eliminated)   return null;

  const c    = candles[idx];
  const prev = candles[idx - 1];
  const next = candles[idx + 1];

  const nextRange = next.high - next.low;
  if (next.open === next.high && next.low > 0 && nextRange / next.low * 100 < 0.5) return null;

  const changePercent = prev.close > 0 ? +((c.close - prev.close) / prev.close * 100).toFixed(2) : 0;
  const entryPrice    = +(next.open * (1 + SLIPPAGE_PCT)).toFixed(2);

  let highWinRateScore = 0;
  try { highWinRateScore = evaluateHighWinRateEntry(candles, idx).score; } catch { /* 略 */ }

  let mtfScore = 0;
  try { mtfScore = evaluateMultiTimeframe(candles.slice(0, idx + 1), MTF_CFG).totalScore; } catch { /* 略 */ }
  if (mtfMin > 0 && mtfScore < mtfMin) return null;

  // 對齊 backtest-run.ts 的「六條件總分」排序
  const rankScore = six.totalScore * 1000 + highWinRateScore * 10 + changePercent / 100;

  return {
    symbol, name, idx, candles, entryPrice,
    totalScore: six.totalScore, changePercent,
    highWinRateScore, mtfScore, rankScore,
  };
}

function exitS1(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
): ExitResult | null {
  let maxGain = 0;
  const entryCandle = candles[entryIdx];
  const rawStopPrice = entryCandle?.low ?? entryPrice * 0.95;
  const floorPrice = entryPrice * 0.95;
  const stopLossPrice = Math.max(rawStopPrice, floorPrice);
  const stopLossPct = entryPrice > 0 ? (stopLossPrice - entryPrice) / entryPrice * 100 : S1_SL_PCT;

  for (let d = 0; d <= S1_MAX_HOLD; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) break;
    const c    = candles[fi];
    const prev = fi > 0 ? candles[fi - 1] : null;

    const closeRet = entryPrice > 0 ? (c.close - entryPrice) / entryPrice * 100 : 0;
    if (closeRet > maxGain) maxGain = closeRet;

    if (d === 0) {
      if (c.close <= stopLossPrice) return { exitIdx: fi, exitPrice: c.close, exitReason: `止損${stopLossPct.toFixed(1)}%（進場日）` };
      continue;
    }
    if (c.close <= stopLossPrice) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: `止損${stopLossPct.toFixed(1)}% 進場K低點` };
    }
    if (maxGain >= S1_PROFIT_GATE_PCT && c.ma5 != null && c.close < c.ma5) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '漲超10%後跌破MA5' };
    }

    const vols5 = Array.from({ length: 5 }, (_, i) => candles[Math.max(0, fi - 1 - i)]?.volume ?? 0);
    const avgVol = vols5.reduce((a, b) => a + b, 0) / vols5.length;
    const volRatio = avgVol > 0 ? (c.volume ?? 0) / avgVol : 0;
    const body = Math.abs(c.close - c.open);

    if (fi >= 3) {
      const prev3Up = [candles[fi-1], candles[fi-2], candles[fi-3]].every(x => x.close > x.open);
      const isLongBlack = c.close < c.open && body / c.open >= 0.02;
      if (prev3Up && isLongBlack && volRatio > 1.5) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '急漲後長黑K' };
      }
    }
    if (prev && prev.close > prev.open && c.close < c.open) {
      const midPrice = (prev.open + prev.close) / 2;
      const kdDownTurn = c.kdK != null && prev.kdK != null && c.kdK < prev.kdK;
      if (c.close < midPrice && kdDownTurn) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '強覆蓋' };
      }
    }
    if (fi >= 10) {
      const recentHighs: number[] = [];
      for (let i = fi - 1; i >= Math.max(1, fi - 20) && recentHighs.length < 2; i--) {
        const ci = candles[i], pi = candles[i-1], ni = candles[i+1];
        if (ci && pi && ni && ci.high > pi.high && ci.high > ni.high) recentHighs.push(ci.high);
      }
      if (recentHighs.length >= 2 && recentHighs[0] < recentHighs[1] && c.close < recentHighs[0]) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '頭頭低' };
      }
    }
    if (c.kdK != null && c.kdD != null && prev?.kdK != null && prev.kdD != null) {
      if (prev.kdK > 70 && prev.kdK >= prev.kdD && c.kdK < c.kdD) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: 'KD高位死叉' };
      }
    }
    if (d === S1_MAX_HOLD) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: `持股${S1_MAX_HOLD}天到期` };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 主迴圈：B1 + 可選 re-entry
// ══════════════════════════════════════════════════════════════

interface RunResult {
  trades: Trade[];
  reentryHits: number; // 觸發再進場的次數
  reentryWins: number; // 再進場交易中獲利筆數
}

function runB1(
  allStocks: Map<string, StockData>,
  tradingDays: string[],
  enableReentry: boolean,
): RunResult {
  const { market, capital: initCapital, topN, mtfMin } = CONFIG;
  const costPct = market === 'TW' ? TW_COST_PCT : CN_COST_PCT;
  const reentryCfg = enableReentry ? ZHU_OPTIMIZED.thresholds.reentry : undefined;

  const trades: Trade[] = [];
  let capital = initCapital;
  let holdingUntilDayIdx = -1;
  let pendingReentry: ReentryWindow | null = null;

  const topNCache = new Map<string, Set<string> | null>();

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    if (dayIdx <= holdingUntilDayIdx) continue;

    const date = tradingDays[dayIdx];

    let picked: SixcondFeatures | null = null;
    let entryType: 'initial' | 'reentry' = 'initial';

    // ── 優先檢查再進場視窗 ─────────────────────────────────────
    if (reentryCfg && pendingReentry) {
      const sd = allStocks.get(pendingReentry.symbol);
      if (sd) {
        const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
        if (idx > 0 && isReentryWindowActive(pendingReentry, idx)) {
          const intact = isTrendIntactSinceWindow(sd.candles, pendingReentry, idx);
          const sig = evaluateReentry(sd.candles, idx, reentryCfg);
          if (process.env.REENTRY_DEBUG) {
            // eslint-disable-next-line no-console
            console.log(`  [reentry-check] ${date} ${pendingReentry.symbol} intact=${intact} trigger=${sig.triggered} fail=${sig.failReason ?? ''}`);
          }
          if (intact && sig.triggered && idx + 1 < sd.candles.length) {
            const next = sd.candles[idx + 1];
            const entryPrice = +(next.open * (1 + SLIPPAGE_PCT)).toFixed(2);
            picked = {
              symbol: pendingReentry.symbol,
              name: sd.name,
              idx,
              candles: sd.candles,
              entryPrice,
              totalScore: 0,
              changePercent: 0,
              highWinRateScore: 0,
              mtfScore: 0,
              rankScore: 0,
            };
            entryType = 'reentry';
          }
        } else {
          pendingReentry = null;  // 視窗過期
        }
      } else {
        pendingReentry = null;
      }
    }

    // ── 視窗有效期內：等同支股票回來，不切換到別檔 ─────────────────
    if (!picked && pendingReentry) {
      const sd = allStocks.get(pendingReentry.symbol);
      const idx = sd?.candles.findIndex(c => c.date?.slice(0, 10) === date) ?? -1;
      if (idx >= 0 && isReentryWindowActive(pendingReentry, idx)) {
        // 視窗仍有效，但今日未觸發 → 跳過今日，繼續等
        continue;
      }
      // 視窗過期才清掉繼續走初次選股
      pendingReentry = null;
    }

    // ── 沒命中再進場 → 走標準六條件選股 ─────────────────────────
    if (!picked) {
      if (topN > 0 && !topNCache.has(date)) {
        topNCache.set(date, buildTopNSet(allStocks, date, topN));
      }
      const topNSet = topNCache.get(date) ?? null;

      const cands: SixcondFeatures[] = [];
      for (const [symbol, sd] of allStocks) {
        const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
        if (idx < 0) continue;
        if (topNSet && !topNSet.has(symbol)) continue;
        const cand = buildInitialCandidate(symbol, sd.name, sd.candles, idx, mtfMin);
        if (cand) cands.push(cand);
      }
      if (cands.length === 0) continue;
      cands.sort((a, b) => b.rankScore - a.rankScore);
      picked = cands[0];
    }

    if (!picked) continue;

    const entryDayIdx = picked.idx + 1;
    if (entryDayIdx >= picked.candles.length) continue;
    const entryPrice = picked.entryPrice;

    const exitResult = exitS1(picked.candles, entryDayIdx, entryPrice);
    if (!exitResult) continue;

    const { exitIdx, exitPrice, exitReason } = exitResult;
    const exitDate = picked.candles[exitIdx]?.date?.slice(0, 10) ?? '';
    const exitDayIdx = tradingDays.indexOf(exitDate);

    const grossPct = (exitPrice - entryPrice) / entryPrice * 100;
    const netPct = grossPct - costPct;
    const pnl = capital * netPct / 100;
    capital = Math.max(0, capital + pnl);

    const entryDate = picked.candles[entryDayIdx]?.date?.slice(0, 10) ?? '';
    const holdDays = exitIdx - entryDayIdx;

    trades.push({
      no: trades.length + 1,
      entryDate, exitDate,
      symbol: picked.symbol,
      name: picked.name,
      entryType,
      entryPrice, exitPrice,
      netPct: +netPct.toFixed(3),
      pnl: +pnl.toFixed(0),
      capitalAfter: +capital.toFixed(0),
      holdDays, exitReason,
    });

    holdingUntilDayIdx = exitDayIdx >= 0 ? exitDayIdx : dayIdx + holdDays;

    // ── 出場後判斷是否開啟再進場視窗 ────────────────────────────
    if (reentryCfg) {
      const cls = classifyExitReason(exitReason);
      if (cls) {
        pendingReentry = buildReentryWindow(picked.symbol, cls, exitIdx, reentryCfg);
      } else {
        pendingReentry = null;
      }
    }
  }

  const reentryTrades = trades.filter(t => t.entryType === 'reentry');
  return {
    trades,
    reentryHits: reentryTrades.length,
    reentryWins: reentryTrades.filter(t => t.netPct > 0).length,
  };
}

// ══════════════════════════════════════════════════════════════
// 報告
// ══════════════════════════════════════════════════════════════

function summarize(label: string, result: RunResult, initCapital: number): void {
  const { trades, reentryHits, reentryWins } = result;
  console.log('\n' + '═'.repeat(72));
  console.log(`  ${label}`);
  console.log('═'.repeat(72));

  if (trades.length === 0) {
    console.log('  ⚠ 無交易記錄');
    return;
  }

  const finalCapital = trades.at(-1)!.capitalAfter;
  const totalReturn = (finalCapital - initCapital) / initCapital * 100;
  const wins = trades.filter(t => t.netPct > 0);
  const losses = trades.filter(t => t.netPct <= 0);
  const winRate = wins.length / trades.length * 100;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const avgHold = trades.reduce((s, t) => s + t.holdDays, 0) / trades.length;

  let peak = initCapital, maxDD = 0;
  let cap = initCapital;
  for (const t of trades) {
    cap = t.capitalAfter;
    if (cap > peak) peak = cap;
    const dd = (peak - cap) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  console.log(`  總報酬      ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}%`);
  console.log(`  最終資金    ${finalCapital.toLocaleString()} 元`);
  console.log(`  交易筆數    ${trades.length} 筆 (再進場 ${reentryHits} 筆)`);
  console.log(`  勝率        ${winRate.toFixed(1)}% (${wins.length}勝 / ${losses.length}負)`);
  console.log(`  平均獲利    +${avgWin.toFixed(2)}%`);
  console.log(`  平均虧損    ${avgLoss.toFixed(2)}%`);
  console.log(`  平均持股    ${avgHold.toFixed(1)} 天`);
  console.log(`  最大回撤    ${maxDD.toFixed(1)}%`);

  if (reentryHits > 0) {
    const reentryReturn = result.trades.filter(t => t.entryType === 'reentry')
      .reduce((s, t) => s + t.netPct, 0);
    const avgReentry = reentryReturn / reentryHits;
    console.log(`  再進場勝率  ${(reentryWins / reentryHits * 100).toFixed(1)}% (${reentryWins}勝 / ${reentryHits - reentryWins}負)`);
    console.log(`  再進場平均  ${avgReentry >= 0 ? '+' : ''}${avgReentry.toFixed(2)}%`);
  }
}

function exportCsv(label: string, trades: Trade[]): void {
  const dir = path.join(process.cwd(), 'data', 'backtest-output');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `reentry-compare-${label}.csv`);
  const header = 'no,entryDate,exitDate,symbol,name,entryType,entryPrice,exitPrice,netPct,pnl,capitalAfter,holdDays,exitReason\n';
  const rows = trades.map(t =>
    `${t.no},${t.entryDate},${t.exitDate},${t.symbol},${t.name},${t.entryType},${t.entryPrice},${t.exitPrice},${t.netPct},${t.pnl},${t.capitalAfter},${t.holdDays},"${t.exitReason}"`
  ).join('\n');
  fs.writeFileSync(file, header + rows + '\n');
  console.log(`  CSV → ${path.relative(process.cwd(), file)}`);
}

// ══════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const { market, period, capital } = CONFIG;
  console.log(`\n  載入 ${market} 資料...`);
  const allStocks = loadStocks(market);

  const tradingDaySet = new Set<string>();
  for (const [, sd] of allStocks) {
    for (const c of sd.candles) {
      const d = c.date?.slice(0, 10);
      if (d && d >= period.start && d <= period.end) tradingDaySet.add(d);
    }
  }
  const tradingDays = [...tradingDaySet].sort();
  console.log(`  交易日：${tradingDays[0]} ～ ${tradingDays.at(-1)} 共 ${tradingDays.length} 天`);

  console.log('\n  跑 baseline (無再進場)...');
  const baseline = runB1(allStocks, tradingDays, false);
  summarize(`Baseline | ${market} ${period.start}~${period.end}`, baseline, capital);
  exportCsv(`${market}-baseline`, baseline.trades);

  console.log('\n  跑 re-entry 版...');
  const withReentry = runB1(allStocks, tradingDays, true);
  summarize(`Re-entry | ${market} ${period.start}~${period.end}`, withReentry, capital);
  exportCsv(`${market}-reentry`, withReentry.trades);

  // ── 對照表 ──
  const baseFinal = baseline.trades.at(-1)?.capitalAfter ?? capital;
  const reFinal = withReentry.trades.at(-1)?.capitalAfter ?? capital;
  const baseRet = (baseFinal - capital) / capital * 100;
  const reRet = (reFinal - capital) / capital * 100;
  console.log('\n' + '═'.repeat(72));
  console.log('  對照結論');
  console.log('═'.repeat(72));
  console.log(`  Baseline       ${baseRet >= 0 ? '+' : ''}${baseRet.toFixed(1)}%  (${baseline.trades.length} 筆)`);
  console.log(`  Re-entry       ${reRet >= 0 ? '+' : ''}${reRet.toFixed(1)}%  (${withReentry.trades.length} 筆，含再進場 ${withReentry.reentryHits} 筆)`);
  console.log(`  差異           ${reRet - baseRet >= 0 ? '+' : ''}${(reRet - baseRet).toFixed(1)} pp`);
  console.log('═'.repeat(72) + '\n');
}

main().catch(console.error);
