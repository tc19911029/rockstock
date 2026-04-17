/**
 * 打板策略乾淨回測 — CN + TW，多排序因子比較
 *
 * ★ 零偷看原則：篩選+排序只用「昨天收盤前已知 + 今天開盤價」
 *
 * 規則：
 *   - 100萬起始，每次 all-in 排名第1檔
 *   - 進場：昨日漲停 + 今日高開≥2% → 開盤價買入
 *   - 出場：TP5% / SL-2% / 最多持有2天 / 收黑隔日走
 *   - 冰點跳過（CN漲停<15家 / TW漲停<5家）
 *
 * 可用資訊（開盤前已知）：
 *   ✅ 昨天 OHLCV（封板力度、成交額、量比、一字板）
 *   ✅ 昨天的連板天數
 *   ✅ 前5~10天的動能（用昨天close）
 *   ✅ 今天開盤價（高開幅度）
 *   ❌ 今天 close / volume / turnover（收盤才知道）
 *
 * Usage: npx tsx scripts/backtest-daban-clean.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

// ── 共用參數 ────────────────────────────────────────────────────────────────

const BACKTEST_START = '2024-04-01';
const BACKTEST_END   = '2026-04-16';
const INITIAL_CAPITAL = 1_000_000;
const LIMIT_UP_PCT   = 9.5;
const GAP_UP_MIN     = 2.0;
const MIN_TURNOVER   = 5e6;
const TAKE_PROFIT    = 5;
const STOP_LOSS      = -2;
const MAX_HOLD_DAYS  = 2;

const CN_COLD = 15;
const TW_COLD = 5;
const CN_COST = 0.16;  // %
const TW_COST = (0.001425 * 0.6 * 2 + 0.003) * 100; // ≈ 0.471%

// ── Types ────────────────────────────────────────────────────────────────────

interface Trade {
  no: number; entryDate: string; exitDate: string;
  symbol: string; name: string; boards: number; gapUp: number;
  entryPrice: number; exitPrice: number;
  netPct: number; pnl: number; capitalAfter: number;
  exitReason: string; rankScore: number;
}

interface Candidate {
  symbol: string; name: string; idx: number;
  candles: CandleWithIndicators[];
  entryPrice: number; gapUp: number; boards: number;
  rankScore: number;
}

interface RankFn {
  name: string;
  fn: (o: { sealStrength: number; yestVR: number; mom5: number; yestTurnover: number; boards: number; gapUp: number; yestClose: number }) => number;
}

interface RunResult {
  rankName: string; market: string;
  trades: Trade[]; capital: number; maxDD: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDayReturn(candles: CandleWithIndicators[], idx: number): number {
  if (idx <= 0) return 0;
  return (candles[idx].close - candles[idx - 1].close) / candles[idx - 1].close * 100;
}

function getConsecutiveLimitUp(candles: CandleWithIndicators[], idx: number): number {
  let count = 0;
  for (let i = idx; i >= 1; i--) {
    if (getDayReturn(candles, i) >= LIMIT_UP_PCT) count++;
    else break;
  }
  return count;
}

function getAvgVolume(candles: CandleWithIndicators[], idx: number, period: number): number {
  let sum = 0;
  const start = Math.max(0, idx - period + 1);
  for (let i = start; i <= idx; i++) sum += (candles[i].volume ?? 0);
  return sum / (idx - start + 1);
}

// ── 排序因子定義（全部只用昨天+開盤價，零偷看）──

const RANK_FUNCTIONS: RankFn[] = [
  {
    name: '多因子(封板+量比+動能+成交額)',
    fn: (o) => o.sealStrength * 2 + Math.min(o.yestVR, 5) / 5 + Math.max(0, o.mom5) / 20 + Math.log10(Math.max(o.yestTurnover, 1)) / 10,
  },
  {
    name: '純成交額',
    fn: (o) => Math.log10(Math.max(o.yestTurnover, 1)),
  },
  {
    name: '封板力度優先',
    fn: (o) => o.sealStrength * 10 + Math.log10(Math.max(o.yestTurnover, 1)) / 10,
  },
  {
    name: '量比優先',
    fn: (o) => Math.min(o.yestVR, 5) * 2 + Math.log10(Math.max(o.yestTurnover, 1)) / 10,
  },
  {
    name: '動能優先',
    fn: (o) => Math.max(0, o.mom5) / 5 + Math.log10(Math.max(o.yestTurnover, 1)) / 10,
  },
  {
    name: '高開幅度優先',
    fn: (o) => o.gapUp * 2 + Math.log10(Math.max(o.yestTurnover, 1)) / 10,
  },
  {
    name: '首板加權+成交額',
    fn: (o) => {
      const bb = o.boards === 1 ? 2.0 : o.boards === 2 ? 1.5 : 1.0;
      return bb * Math.log10(Math.max(o.yestTurnover, 1));
    },
  },
  {
    name: '低價優先',
    fn: (o) => {
      const priceBonus = o.yestClose < 10 ? 2.0 : o.yestClose < 20 ? 1.5 : o.yestClose < 50 ? 1.2 : 1.0;
      return priceBonus * Math.log10(Math.max(o.yestTurnover, 1));
    },
  },
  {
    name: '封板+首板+成交額',
    fn: (o) => {
      const bb = o.boards === 1 ? 1.5 : 1.0;
      return o.sealStrength * 2 + bb + Math.log10(Math.max(o.yestTurnover, 1)) / 10;
    },
  },
  {
    name: '連板優先',
    fn: (o) => o.boards * 3 + Math.log10(Math.max(o.yestTurnover, 1)) / 10,
  },
];

// ── 載入數據 ─────────────────────────────────────────────────────────────────

function loadStocks(market: 'CN' | 'TW'): Map<string, { name: string; candles: CandleWithIndicators[] }> {
  const allStocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();

  if (market === 'CN') {
    // 先讀 bulk cache
    const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');
    if (fs.existsSync(cacheFile)) {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: unknown[] }>)) {
        if (!data.candles || data.candles.length < 60) continue;
        if (data.name.includes('ST')) continue;
        try { allStocks.set(sym, { name: data.name, candles: computeIndicators(data.candles as CandleWithIndicators[]) }); } catch {}
      }
    }
    // 補充 per-symbol
    const dir = path.join(process.cwd(), 'data', 'candles', 'CN');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        const sym = f.replace('.json', '');
        try {
          const raw2 = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          const c2 = Array.isArray(raw2) ? raw2 : raw2.candles ?? raw2;
          if (!c2 || c2.length < 60) continue;
          const existing = allStocks.get(sym);
          const lastE = existing?.candles[existing.candles.length - 1]?.date?.slice(0, 10) ?? '';
          const lastN = c2[c2.length - 1]?.date?.slice(0, 10) ?? '';
          if (lastN > lastE) {
            const nm = (raw2 as any).name ?? existing?.name ?? sym;
            if (typeof nm === 'string' && nm.includes('ST')) continue;
            allStocks.set(sym, { name: nm, candles: computeIndicators(c2) });
          }
        } catch {}
      }
    }
  } else {
    const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        const c = Array.isArray(raw) ? raw : raw.candles ?? raw;
        if (!c || c.length < 60) continue;
        const sym = f.replace('.json', '');
        allStocks.set(sym, { name: (raw as any).name ?? sym, candles: computeIndicators(c) });
      } catch {}
    }
  }
  return allStocks;
}

// ── 回測引擎 ─────────────────────────────────────────────────────────────────

function runBacktest(
  market: 'CN' | 'TW',
  allStocks: Map<string, { name: string; candles: CandleWithIndicators[] }>,
  tradingDays: string[],
  rankFn: RankFn,
): RunResult {
  const costPct = market === 'CN' ? CN_COST : TW_COST;
  const coldThreshold = market === 'CN' ? CN_COLD : TW_COLD;

  const trades: Trade[] = [];
  let holdingUntilIdx = -1;
  let capital = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let maxDD = 0;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    if (dayIdx <= holdingUntilIdx) continue;
    const date = tradingDays[dayIdx];

    // ── 市場情緒：用昨天的漲停家數（開盤前已知）──
    let yestLimitUpCount = 0;
    for (const [, sd] of allStocks) {
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 2) continue;
      if (getDayReturn(sd.candles, idx - 1) >= LIMIT_UP_PCT) yestLimitUpCount++;
    }
    if (yestLimitUpCount < coldThreshold) continue;

    // ── 找候選（零偷看）──
    const cands: Candidate[] = [];

    for (const [symbol, sd] of allStocks) {
      const candles = sd.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 10 || idx + 3 >= candles.length) continue;

      const today = candles[idx];     // 只用 open
      const yest = candles[idx - 1];  // 昨天（漲停日）— 全部已知
      const db = candles[idx - 2];

      // 篩選條件（全部開盤前已知）
      const prevGain = (yest.close - db.close) / db.close * 100;
      if (prevGain < LIMIT_UP_PCT) continue;

      const gapUp = (today.open - yest.close) / yest.close * 100;
      if (gapUp < GAP_UP_MIN) continue;

      const yestVol = yest.volume ?? 0;
      const yestTurnover = yestVol * yest.close;
      if (yestTurnover < MIN_TURNOVER) continue;

      // 昨天一字板（散戶買不到的漲停）
      if (yest.open === yest.high && yest.high === yest.close) continue;

      // 排序因子（全部用昨天數據）
      const boards = getConsecutiveLimitUp(candles, idx - 1);
      const avgVol5 = getAvgVolume(candles, idx - 1, 5);
      const yestVR = avgVol5 > 0 ? yestVol / avgVol5 : 1;

      const yRange = yest.high - yest.low;
      const sealStrength = yRange > 0
        ? 1 - (yest.high - Math.max(yest.open, yest.close)) / yRange
        : 1;

      const mom5 = idx >= 6 ? (yest.close / candles[idx - 6].close - 1) * 100 : 0;

      const rankScore = rankFn.fn({ sealStrength, yestVR, mom5, yestTurnover, boards, gapUp, yestClose: yest.close });

      cands.push({ symbol, name: sd.name, idx, candles, entryPrice: today.open, gapUp: +gapUp.toFixed(2), boards, rankScore });
    }

    if (cands.length === 0) continue;
    cands.sort((a, b) => b.rankScore - a.rankScore);
    const pick = cands[0];

    // ── 模擬交易 ──
    const entry = pick.entryPrice;
    const { candles } = pick;
    const entryIdx = pick.idx;
    let exitIdx = entryIdx;
    let exitPrice = entry;
    let exitReason = '';

    for (let d = 1; d <= MAX_HOLD_DAYS; d++) {
      const fi = entryIdx + d;
      if (fi >= candles.length) break;
      const c = candles[fi];
      const hRet = (c.high - entry) / entry * 100;
      const lRet = (c.low - entry) / entry * 100;

      if (hRet >= TAKE_PROFIT) { exitIdx = fi; exitPrice = +(entry * (1 + TAKE_PROFIT / 100)).toFixed(2); exitReason = `止盈+${TAKE_PROFIT}%`; break; }
      if (lRet <= STOP_LOSS) { exitIdx = fi; exitPrice = +(entry * (1 + STOP_LOSS / 100)).toFixed(2); exitReason = `止損${STOP_LOSS}%`; break; }
      if (d === MAX_HOLD_DAYS) { exitIdx = fi; exitPrice = c.close; exitReason = '持有到期'; break; }
      if (d === 1 && c.close < c.open) {
        const ni = fi + 1;
        if (ni < candles.length) { exitIdx = ni; exitPrice = candles[ni].open; exitReason = '收黑隔日走'; break; }
      }
    }
    if (exitIdx === entryIdx) continue;

    const grossPct = (exitPrice - entry) / entry * 100;
    const netPct = +(grossPct - costPct).toFixed(2);
    const pnl = Math.round(capital * netPct / 100);
    capital += pnl;

    const exitDate = candles[exitIdx]?.date?.slice(0, 10) ?? '';
    const edi = tradingDays.indexOf(exitDate);
    holdingUntilIdx = edi >= 0 ? edi : dayIdx + (exitIdx - entryIdx);

    if (capital > peak) peak = capital;
    const dd = (peak - capital) / peak * 100;
    if (dd > maxDD) maxDD = dd;

    trades.push({
      no: trades.length + 1, entryDate: date, exitDate,
      symbol: pick.symbol, name: pick.name, boards: pick.boards,
      gapUp: pick.gapUp, entryPrice: entry, exitPrice,
      netPct, pnl, capitalAfter: capital,
      exitReason, rankScore: pick.rankScore,
    });
  }

  return { rankName: rankFn.name, market, trades, capital, maxDD };
}

// ── 輸出 ─────────────────────────────────────────────────────────────────────

function printComparison(results: RunResult[], market: string) {
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`  ${market === 'CN' ? '陸股' : '台股'}打板 — 排序策略比較（零偷看，${BACKTEST_START} ~ ${BACKTEST_END}）`);
  console.log(`  進場：昨日漲停+今日高開≥2% | 出場：TP${TAKE_PROFIT}%/SL${STOP_LOSS}%/持有${MAX_HOLD_DAYS}天/收黑走 | 費用：${market === 'CN' ? CN_COST : TW_COST.toFixed(3)}%`);
  console.log(`${'═'.repeat(120)}\n`);

  console.log(
    '  #' + '  ' +
    '排序策略'.padEnd(34) +
    '筆數'.padStart(5) +
    '勝率'.padStart(7) +
    '均報酬'.padStart(8) +
    '總報酬'.padStart(10) +
    '最終資金'.padStart(14) +
    '均勝'.padStart(8) +
    '均負'.padStart(8) +
    '盈虧比'.padStart(7) +
    '最大DD'.padStart(8) +
    '連勝'.padStart(5) +
    '連敗'.padStart(5)
  );
  console.log('  ' + '─'.repeat(118));

  const sorted = [...results].sort((a, b) => b.capital - a.capital);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const { trades } = r;
    if (trades.length === 0) {
      console.log(`  ${(i + 1).toString().padStart(2)}  ${r.rankName.padEnd(34)}    0筆 — 無交易`);
      continue;
    }
    const wins = trades.filter(t => t.netPct > 0);
    const losses = trades.filter(t => t.netPct <= 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
    const avgRet = trades.reduce((s, t) => s + t.netPct, 0) / trades.length;
    const totalRet = (r.capital / INITIAL_CAPITAL - 1) * 100;
    const pf = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : 0;

    let mxW = 0, mxL = 0, cw = 0, cl = 0;
    for (const t of trades) {
      if (t.netPct > 0) { cw++; cl = 0; mxW = Math.max(mxW, cw); }
      else { cl++; cw = 0; mxL = Math.max(mxL, cl); }
    }

    console.log(
      '  ' + (i + 1).toString().padStart(2) + '  ' +
      r.rankName.padEnd(34) +
      trades.length.toString().padStart(5) +
      ((wins.length / trades.length * 100).toFixed(1) + '%').padStart(7) +
      ((avgRet >= 0 ? '+' : '') + avgRet.toFixed(2) + '%').padStart(8) +
      ((totalRet >= 0 ? '+' : '') + totalRet.toFixed(1) + '%').padStart(10) +
      r.capital.toLocaleString().padStart(14) +
      ('+' + avgWin.toFixed(2) + '%').padStart(8) +
      (avgLoss.toFixed(2) + '%').padStart(8) +
      pf.toFixed(2).padStart(7) +
      (r.maxDD.toFixed(1) + '%').padStart(8) +
      (mxW + '').padStart(5) +
      (mxL + '').padStart(5)
    );
  }
  console.log('  ' + '─'.repeat(118));

  // 最佳策略交易明細
  const best = sorted[0];
  console.log(`\n  最佳：${best.rankName}（${best.trades.length}筆）\n`);
  console.log('    #  買入日      賣出日      股票         名稱      連板  高開    買入      賣出     淨利      損益(元)     帳戶餘額       出場');
  console.log('  ' + '─'.repeat(120));

  for (const t of best.trades) {
    console.log(
      '  ' + t.no.toString().padStart(3) + '  ' +
      t.entryDate + '  ' + t.exitDate + '  ' +
      t.symbol.padEnd(12) + ' ' + t.name.slice(0, 6).padEnd(8) +
      (t.boards + '板').padStart(4) + '  ' +
      ('+' + t.gapUp.toFixed(1) + '%').padStart(6) + ' ' +
      t.entryPrice.toFixed(2).padStart(8) + '  ' +
      t.exitPrice.toFixed(2).padStart(8) + '  ' +
      ((t.netPct >= 0 ? '+' : '') + t.netPct.toFixed(2) + '%').padStart(7) + '  ' +
      ((t.pnl >= 0 ? '+' : '') + t.pnl.toLocaleString()).padStart(10) + '  ' +
      t.capitalAfter.toLocaleString().padStart(13) + '  ' +
      t.exitReason
    );
  }

  // 月度
  console.log('\n  月度績效:');
  const mm = new Map<string, { t: number; w: number; ret: number; cap: number }>();
  for (const t of best.trades) {
    const m = t.entryDate.slice(0, 7);
    if (!mm.has(m)) mm.set(m, { t: 0, w: 0, ret: 0, cap: 0 });
    const e = mm.get(m)!;
    e.t++; if (t.netPct > 0) e.w++; e.ret += t.netPct; e.cap = t.capitalAfter;
  }
  console.log('    月份      筆數  勝/負  勝率    月報酬     月末資金');
  console.log('  ' + '─'.repeat(55));
  for (const [m, e] of [...mm.entries()].sort()) {
    console.log(`    ${m}   ${e.t.toString().padStart(4)}   ${e.w}/${e.t - e.w}   ${(e.w / e.t * 100).toFixed(0).padStart(4)}%  ${((e.ret >= 0 ? '+' : '') + e.ret.toFixed(2) + '%').padStart(9)}  ${e.cap.toLocaleString().padStart(13)}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  打板乾淨回測 — CN + TW × 10 種排序因子                   ║');
  console.log('║  ★ 零偷看：篩選+排序只用昨天數據+今天開盤價 ★             ║');
  console.log(`║  期間：${BACKTEST_START} ~ ${BACKTEST_END}                          ║`);
  console.log('║  100萬 all-in 第1名，TP5% SL-2%                          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  // ── CN ──
  console.log('\n  載入陸股...');
  const cnStocks = loadStocks('CN');
  const cnBench = cnStocks.get('000001.SZ') ?? cnStocks.get('601318.SS');
  if (!cnBench) { console.error('CN 找不到基準'); return; }
  const cnDays = cnBench.candles.map(c => c.date?.slice(0, 10)).filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
  console.log(`  ${cnStocks.size} 支, ${cnDays.length} 交易日`);

  const cnResults: RunResult[] = [];
  for (let i = 0; i < RANK_FUNCTIONS.length; i++) {
    process.stdout.write(`\r  CN 回測 ${i + 1}/${RANK_FUNCTIONS.length}: ${RANK_FUNCTIONS[i].name}...`);
    cnResults.push(runBacktest('CN', cnStocks, cnDays, RANK_FUNCTIONS[i]));
  }
  console.log('\r  CN 回測完成                                    ');

  printComparison(cnResults, 'CN');

  // ── TW ──
  console.log('\n  載入台股...');
  const twStocks = loadStocks('TW');
  const twBenchSyms = ['2330.TW', '0050.TW', '2317.TW'];
  let twBench: { name: string; candles: CandleWithIndicators[] } | undefined;
  for (const s of twBenchSyms) { twBench = twStocks.get(s); if (twBench) break; }
  if (!twBench) { console.error('TW 找不到基準'); return; }
  const twDays = twBench.candles.map(c => c.date?.slice(0, 10)).filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
  console.log(`  ${twStocks.size} 支, ${twDays.length} 交易日`);

  const twResults: RunResult[] = [];
  for (let i = 0; i < RANK_FUNCTIONS.length; i++) {
    process.stdout.write(`\r  TW 回測 ${i + 1}/${RANK_FUNCTIONS.length}: ${RANK_FUNCTIONS[i].name}...`);
    twResults.push(runBacktest('TW', twStocks, twDays, RANK_FUNCTIONS[i]));
  }
  console.log('\r  TW 回測完成                                    ');

  printComparison(twResults, 'TW');

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  全部回測完成（零偷看）                                    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
}

main().catch(console.error);
