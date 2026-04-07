/**
 * 回測：MTF 當篩選門檻 + 共振/高勝排序 → 3日漲幅（實戰版）
 *
 * 改進：
 *   1. 扣手續費（台股 0.585%/筆、陸股 0.1%/筆）
 *   2. 複利計算（本金滾動）
 *   3. 樣本外驗證（前半訓練、後半驗證）
 *
 * Usage:
 *   npx tsx scripts/backtest-mtf-filter-ranking.ts              # 台股
 *   npx tsx scripts/backtest-mtf-filter-ranking.ts --market CN  # 陸股
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators } from '../lib/indicators';
import { evaluateSixConditions } from '../lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe } from '../lib/analysis/multiTimeframeFilter';
import { evaluateHighWinRateEntry } from '../lib/analysis/highWinRateEntry';
import { checkLongProhibitions } from '../lib/rules/entryProhibitions';
import { evaluateElimination } from '../lib/scanner/eliminationFilter';
import { ruleEngine } from '../lib/rules/ruleEngine';
import { ZHU_V1 } from '../lib/strategy/StrategyConfig';
import type { CandleWithIndicators, Candle } from '../types';

const thresholds = ZHU_V1.thresholds;

const BACKTEST_START = '2024-04-01';
const BACKTEST_MID   = '2025-04-01'; // 訓練/驗證分界
const BACKTEST_END   = '2026-04-04';
const FORWARD_DAY    = 3;
const TOP_N          = 1;

const MTF_THRESHOLDS = [0, 1, 2, 3, 4];
const RANK_COMBOS = [
  { name: '純共振',       wR: 1.0, wH: 0   },
  { name: '共振70+高勝30', wR: 0.7, wH: 0.3 },
  { name: '等權50:50',    wR: 0.5, wH: 0.5 },
  { name: '共振30+高勝70', wR: 0.3, wH: 0.7 },
  { name: '純高勝',       wR: 0,   wH: 1.0 },
];

// ── Parse args ───────────────────────────────────────────────────────────────
const marketIdx = process.argv.indexOf('--market');
const market = marketIdx >= 0 ? (process.argv[marketIdx + 1] ?? 'TW') : 'TW';
const label = market === 'CN' ? '陸股' : '台股';
const FEE_RATE = market === 'CN' ? 0.1 : 0.585; // 每筆手續費 %

const cacheFile = path.join(process.cwd(), 'data',
  market === 'CN' ? 'backtest-candles-cn.json' : 'backtest-candles.json');

const benchmarks = market === 'CN'
  ? ['600519.SS', '601318.SS', '000001.SZ']
  : ['2330.TW', '2317.TW', '2454.TW'];

interface CacheData {
  savedAt: string;
  stocks: Record<string, { name: string; candles: Candle[] }>;
}

interface Candidate {
  symbol: string;
  name: string;
  candleIdx: number;
  candles: CandleWithIndicators[];
  mtfScore: number;
  resonanceScore: number;
  highWinRateScore: number;
}

interface DailyPick {
  date: string;
  symbol: string;
  name: string;
  ret1d: number | null;
  ret2d: number | null;
  ret3d: number | null;
}

interface CellStats {
  returns: number[];
  dailyPicks: DailyPick[];
  noCandidateDays: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function findDateIndex(candles: CandleWithIndicators[], targetDate: string): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    const d = candles[i].date?.slice(0, 10);
    if (d && d <= targetDate) return i;
  }
  return -1;
}

/** 計算報酬率（已扣手續費） */
function forwardReturn(candles: CandleWithIndicators[], idx: number, days: number): number | null {
  const exit = idx + days;
  if (exit >= candles.length) return null;
  const entry = candles[idx].close;
  if (!entry || entry <= 0) return null;
  const rawRet = (candles[exit].close - entry) / entry * 100;
  return +(rawRet - FEE_RATE).toFixed(2); // 扣手續費
}

/** 複利計算 */
function compoundReturn(returns: number[]): number {
  let equity = 1;
  for (const r of returns) {
    equity *= (1 + r / 100);
  }
  return (equity - 1) * 100;
}

const fmtPct = (v: number | null) => v == null ? '    N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`.padStart(8);

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  回測：MTF篩選 × 共振/高勝排序（${label}・實戰版）`);
  console.log(`  手續費：每筆 ${FEE_RATE}%`);
  console.log(`  訓練期：${BACKTEST_START} ~ ${BACKTEST_MID}`);
  console.log(`  驗證期：${BACKTEST_MID} ~ ${BACKTEST_END}`);
  console.log(`  每天前${TOP_N}檔，看${FORWARD_DAY}日漲幅`);
  console.log(`═══════════════════════════════════════════════════\n`);

  if (!fs.existsSync(cacheFile)) {
    console.error(`❌ 找不到快取 ${cacheFile}`);
    return;
  }

  const raw: CacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  console.log(`📦 載入快取（${raw.savedAt}）`);

  const allCandles = new Map<string, { candles: CandleWithIndicators[]; name: string }>();
  for (const [symbol, data] of Object.entries(raw.stocks)) {
    if (data.candles.length >= 60) {
      allCandles.set(symbol, { candles: computeIndicators(data.candles), name: data.name });
    }
  }
  console.log(`   ${allCandles.size} 支股票\n`);

  let benchCandles: CandleWithIndicators[] | undefined;
  for (const s of benchmarks) {
    benchCandles = allCandles.get(s)?.candles;
    if (benchCandles && benchCandles.length > 100) break;
  }
  if (!benchCandles) { console.error('❌ 找不到基準股'); return; }

  const allTradingDays = benchCandles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);

  const trainDays = allTradingDays.filter(d => d < BACKTEST_MID);
  const testDays  = allTradingDays.filter(d => d >= BACKTEST_MID);

  console.log(`📅 訓練期 ${trainDays.length} 天，驗證期 ${testDays.length} 天\n`);

  // ── 收集每天候選股 ──
  const dailyCandidates = new Map<string, Candidate[]>();

  let dayCount = 0;
  for (const date of allTradingDays) {
    dayCount++;
    if (dayCount % 20 === 0) console.log(`   處理進度：${dayCount}/${allTradingDays.length} 天`);

    const candidates: Candidate[] = [];
    for (const [symbol, data] of allCandles) {
      const idx = findDateIndex(data.candles, date);
      if (idx < 60) continue;
      if (data.candles[idx].date?.slice(0, 10) !== date) continue;

      const sixConds = evaluateSixConditions(data.candles, idx, thresholds);
      if (!sixConds.isCoreReady) continue;

      const last = data.candles[idx];
      if (last.kdK != null && idx > 0) {
        const prevKdK = data.candles[idx - 1]?.kdK;
        if (prevKdK != null && last.kdK < prevKdK) continue;
      }
      const dayRange = last.high - last.low;
      const upperShadow = last.high - last.close;
      if (dayRange > 0 && upperShadow / dayRange > 0.5) continue;

      const prohib = checkLongProhibitions(data.candles, idx);
      if (prohib.prohibited) continue;
      const elimination = evaluateElimination(data.candles, idx);
      if (elimination.eliminated) continue;

      const mtf = evaluateMultiTimeframe(data.candles.slice(0, idx + 1), thresholds);
      const signals = ruleEngine.evaluate(data.candles, idx);
      const buySignals = signals.filter(s => s.type === 'BUY' || s.type === 'ADD');
      const uniqueGroups = new Set(buySignals.map(s =>
        'groupId' in s ? (s as { groupId: string }).groupId : s.ruleId.split('.')[0]
      ));

      let highWinRateScore = 0;
      try { highWinRateScore = evaluateHighWinRateEntry(data.candles, idx).score; } catch {}

      candidates.push({
        symbol, name: data.name, candleIdx: idx, candles: data.candles,
        mtfScore: mtf.totalScore,
        resonanceScore: buySignals.length + uniqueGroups.size,
        highWinRateScore,
      });
    }
    dailyCandidates.set(date, candidates);
  }

  // ── 跑指定天數的回測 ──
  function runBacktest(days: string[]): CellStats[][] {
    const mat: CellStats[][] = MTF_THRESHOLDS.map(() =>
      RANK_COMBOS.map(() => ({ returns: [], dailyPicks: [], noCandidateDays: 0 }))
    );

    for (const date of days) {
      const candidates = dailyCandidates.get(date);
      if (!candidates) continue;

      for (let mi = 0; mi < MTF_THRESHOLDS.length; mi++) {
        const filtered = candidates.filter(c => c.mtfScore >= MTF_THRESHOLDS[mi]);

        for (let ci = 0; ci < RANK_COMBOS.length; ci++) {
          const cell = mat[mi][ci];
          if (filtered.length === 0) { cell.noCandidateDays++; continue; }

          const combo = RANK_COMBOS[ci];
          const maxR = Math.max(1, ...filtered.map(c => c.resonanceScore));
          const maxH = Math.max(1, ...filtered.map(c => c.highWinRateScore));

          const sorted = [...filtered].sort((a, b) => {
            const sa = (a.resonanceScore / maxR) * combo.wR + (a.highWinRateScore / maxH) * combo.wH;
            const sb = (b.resonanceScore / maxR) * combo.wR + (b.highWinRateScore / maxH) * combo.wH;
            return sb - sa;
          });

          const pick = sorted[0];
          const ret = forwardReturn(pick.candles, pick.candleIdx, FORWARD_DAY);
          if (ret != null) cell.returns.push(ret);

          cell.dailyPicks.push({
            date, symbol: pick.symbol, name: pick.name,
            ret1d: forwardReturn(pick.candles, pick.candleIdx, 1),
            ret2d: forwardReturn(pick.candles, pick.candleIdx, 2),
            ret3d: forwardReturn(pick.candles, pick.candleIdx, 3),
          });
        }
      }
    }
    return mat;
  }

  // ── 印矩陣 + 排名，回傳冠軍 [mi, ci] ──
  function printResults(mat: CellStats[][], periodName: string, days: string[]): [number, number] {
    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`  ${periodName}（已扣手續費 ${FEE_RATE}%/筆）`);
    console.log(`  ${FORWARD_DAY}日報酬矩陣（均報/勝率）`);
    console.log(`═══════════════════════════════════════════════════\n`);

    const colW = 14;
    console.log('MTF門檻'.padEnd(10) + RANK_COMBOS.map(c => c.name.padStart(colW)).join('') + '  天數'.padStart(8));
    console.log('─'.repeat(10 + colW * RANK_COMBOS.length + 8));

    let bestAvg = -999, bestMi = 0, bestCi = 0;

    for (let mi = 0; mi < MTF_THRESHOLDS.length; mi++) {
      const cells = RANK_COMBOS.map((_, ci) => {
        const cell = mat[mi][ci];
        if (cell.returns.length === 0) return '     N/A   '.padStart(colW);
        const avg = cell.returns.reduce((a, b) => a + b, 0) / cell.returns.length;
        if (avg > bestAvg) { bestAvg = avg; bestMi = mi; bestCi = ci; }
        const win = cell.returns.filter(r => r > 0).length / cell.returns.length * 100;
        return `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%/${win.toFixed(0)}%`.padStart(colW);
      }).join('');
      const activeDays = days.length - mat[mi][0].noCandidateDays;
      console.log(`${'MTF≥' + MTF_THRESHOLDS[mi]}`.padEnd(10) + cells + (activeDays + '天').padStart(8));
    }

    // 排名
    console.log(`\n  排名（${FORWARD_DAY}日均報）：`);
    const all: { mtf: number; combo: string; avg: number; win: number; cum: number; compound: number; pf: number; n: number }[] = [];
    for (let mi = 0; mi < MTF_THRESHOLDS.length; mi++) {
      for (let ci = 0; ci < RANK_COMBOS.length; ci++) {
        const a = mat[mi][ci].returns;
        if (a.length === 0) continue;
        const avg = a.reduce((s, v) => s + v, 0) / a.length;
        const win = a.filter(r => r > 0).length / a.length * 100;
        const cum = a.reduce((s, v) => s + v, 0);
        const compound = compoundReturn(a);
        const tw = a.filter(r => r > 0).reduce((s, v) => s + v, 0);
        const tl = Math.abs(a.filter(r => r <= 0).reduce((s, v) => s + v, 0));
        all.push({ mtf: MTF_THRESHOLDS[mi], combo: RANK_COMBOS[ci].name, avg, win, cum, compound, pf: tl > 0 ? tw / tl : 999, n: a.length });
      }
    }
    all.sort((a, b) => b.avg - a.avg);
    const medals = ['🥇', '🥈', '🥉'];
    all.slice(0, 10).forEach((r, i) => {
      const prefix = i < 3 ? medals[i] : '  ';
      console.log(
        `  ${prefix} ${(i + 1).toString().padStart(2)}. MTF≥${r.mtf} ${r.combo.padEnd(14)} ` +
        `均報:${fmtPct(r.avg)}  勝率:${r.win.toFixed(1)}%  ` +
        `加總:${fmtPct(r.cum)}  複利:${fmtPct(r.compound)}  ` +
        `盈虧比:${r.pf.toFixed(2)}  (${r.n}筆)`
      );
    });

    return [bestMi, bestCi];
  }

  // ── 印每日明細 ──
  function printDailyDetail(mat: CellStats[][], mi: number, ci: number) {
    const picks = mat[mi][ci].dailyPicks;
    const rets = mat[mi][ci].returns;

    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`  「MTF≥${MTF_THRESHOLDS[mi]} + ${RANK_COMBOS[ci].name}」每日選股明細（已扣手續費）`);
    console.log(`═══════════════════════════════════════════════════\n`);

    console.log(`${'日期'.padEnd(12)} ${'股票'.padEnd(12)} ${'名稱'.padEnd(10)} ${'1D'.padStart(8)} ${'2D'.padStart(8)} ${'3D'.padStart(8)}`);
    console.log('─'.repeat(62));

    let cum1d = 0, cum2d = 0, cum3d = 0;
    let cnt1d = 0, cnt2d = 0, cnt3d = 0;
    for (const p of picks) {
      console.log(
        `${p.date.padEnd(12)} ${p.symbol.padEnd(12)} ${p.name.slice(0, 8).padEnd(10)} ${fmtPct(p.ret1d)} ${fmtPct(p.ret2d)} ${fmtPct(p.ret3d)}`
      );
      if (p.ret1d != null) { cum1d += p.ret1d; cnt1d++; }
      if (p.ret2d != null) { cum2d += p.ret2d; cnt2d++; }
      if (p.ret3d != null) { cum3d += p.ret3d; cnt3d++; }
    }
    console.log('─'.repeat(62));
    console.log(`${'加總'.padEnd(12)} ${''.padEnd(12)} ${''.padEnd(10)} ${fmtPct(cum1d)} ${fmtPct(cum2d)} ${fmtPct(cum3d)}`);
    console.log(`${'複利'.padEnd(12)} ${''.padEnd(12)} ${''.padEnd(10)} ${fmtPct(cnt1d > 0 ? compoundReturn(picks.filter(p => p.ret1d != null).map(p => p.ret1d!)) : null)} ${fmtPct(cnt2d > 0 ? compoundReturn(picks.filter(p => p.ret2d != null).map(p => p.ret2d!)) : null)} ${fmtPct(cnt3d > 0 ? compoundReturn(picks.filter(p => p.ret3d != null).map(p => p.ret3d!)) : null)}`);
    console.log(`${'均報'.padEnd(12)} ${''.padEnd(12)} ${''.padEnd(10)} ${fmtPct(cnt1d > 0 ? cum1d / cnt1d : null)} ${fmtPct(cnt2d > 0 ? cum2d / cnt2d : null)} ${fmtPct(cnt3d > 0 ? cum3d / cnt3d : null)}`);
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 第 1 輪：訓練期
  // ═══════════════════════════════════════════════════════════════════════════
  const trainMat = runBacktest(trainDays);
  const [trainBestMi, trainBestCi] = printResults(trainMat, `訓練期（${BACKTEST_START} ~ ${BACKTEST_MID}）`, trainDays);

  console.log(`\n  ★ 訓練期冠軍：MTF≥${MTF_THRESHOLDS[trainBestMi]} + ${RANK_COMBOS[trainBestCi].name}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 第 2 輪：驗證期（用訓練期冠軍的配比）
  // ═══════════════════════════════════════════════════════════════════════════
  const testMat = runBacktest(testDays);
  printResults(testMat, `驗證期（${BACKTEST_MID} ~ ${BACKTEST_END}）`, testDays);

  // 比較訓練期冠軍在驗證期的表現
  const trainCell = trainMat[trainBestMi][trainBestCi];
  const testCell  = testMat[trainBestMi][trainBestCi];

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  樣本外驗證：訓練期冠軍在驗證期的表現`);
  console.log(`═══════════════════════════════════════════════════\n`);

  const trainAvg = trainCell.returns.length > 0 ? trainCell.returns.reduce((a, b) => a + b, 0) / trainCell.returns.length : 0;
  const testAvg  = testCell.returns.length > 0 ? testCell.returns.reduce((a, b) => a + b, 0) / testCell.returns.length : 0;
  const trainWin = trainCell.returns.length > 0 ? trainCell.returns.filter(r => r > 0).length / trainCell.returns.length * 100 : 0;
  const testWin  = testCell.returns.length > 0 ? testCell.returns.filter(r => r > 0).length / testCell.returns.length * 100 : 0;
  const trainCompound = compoundReturn(trainCell.returns);
  const testCompound  = compoundReturn(testCell.returns);

  console.log(`   配比：MTF≥${MTF_THRESHOLDS[trainBestMi]} + ${RANK_COMBOS[trainBestCi].name}`);
  console.log(`                    訓練期          驗證期`);
  console.log(`   ${FORWARD_DAY}日均報:      ${fmtPct(trainAvg)}       ${fmtPct(testAvg)}`);
  console.log(`   勝率:          ${trainWin.toFixed(1).padStart(6)}%       ${testWin.toFixed(1).padStart(6)}%`);
  console.log(`   複利累積:    ${fmtPct(trainCompound)}     ${fmtPct(testCompound)}`);
  console.log(`   筆數:          ${trainCell.returns.length.toString().padStart(6)}        ${testCell.returns.length.toString().padStart(6)}`);

  const verdict = testAvg > 0
    ? (testAvg >= trainAvg * 0.5 ? '✅ 策略穩健，驗證期表現一致' : '⚠️ 策略可用，但驗證期衰減明顯')
    : '❌ 過擬合風險，驗證期虧損';
  console.log(`\n   結論：${verdict}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 全期間每日明細（訓練期冠軍配比）
  // ═══════════════════════════════════════════════════════════════════════════
  const fullMat = runBacktest(allTradingDays);
  printDailyDetail(fullMat, trainBestMi, trainBestCi);
}

main().catch(console.error);
