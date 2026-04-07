/**
 * MTF 門檻 vs 漲幅潛力分析
 *
 * 測試：MTF 分數越高，是否會篩掉漲幅潛力大的股票？
 *
 * 方法：對通過 Layer 1-3 的候選股，計算後續 1/2/3/4/5 日的實際漲幅，
 * 按 MTF 分數（0-4）分組統計。
 *
 * Usage: npx tsx scripts/analyze-mtf-potential.ts
 */

import fs from 'fs';
import path from 'path';
import { loadAndPrepare } from '../lib/backtest/optimizer/candidateCollector';
import type { CacheData } from '../lib/backtest/optimizer/candidateCollector';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe } from '@/lib/analysis/multiTimeframeFilter';
import { checkLongProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';
import type { CandleWithIndicators } from '@/types';

const BACKTEST_START = '2021-06-01';
const BACKTEST_END   = '2026-04-04';
const TW_BENCHMARKS  = ['2330.TW', '2317.TW', '2454.TW'];

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles.json');

interface CandidateReturn {
  mtfScore: number;
  day1: number | null;  // next day return %
  day2: number | null;
  day3: number | null;
  day4: number | null;
  day5: number | null;
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  MTF 門檻 vs 漲幅潛力分析（台股）');
  console.log(`  期間：${BACKTEST_START} ~ ${BACKTEST_END}`);
  console.log('  篩選：Layer 1 (六條件≥5) + Layer 1b (KD/上影) + Layer 2 (十戒) + Layer 3 (淘汰法)');
  console.log('  分析：通過篩選後，按 MTF 分數分組，看後 1~5 日漲幅');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!fs.existsSync(cacheFile)) {
    console.error('❌ 找不到快取');
    return;
  }

  const raw: CacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const data = loadAndPrepare(raw, TW_BENCHMARKS, 'TW', BACKTEST_START, BACKTEST_END);
  console.log(`   ${data.allCandles.size} 支股票`);
  console.log(`   ${data.tradingDays.length} 個交易日\n`);

  const results: CandidateReturn[] = [];
  let dayCount = 0;

  for (const date of data.tradingDays) {
    dayCount++;
    if (dayCount % 50 === 0) {
      console.log(`   進度：${dayCount}/${data.tradingDays.length} 天`);
    }

    for (const [symbol, stockData] of data.allCandles) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 60 || idx >= candles.length - 5) continue;

      // ── Layer 1: 六條件 ──
      const sixConds = evaluateSixConditions(candles, idx);
      if (!sixConds.isCoreReady) continue;
      if (sixConds.totalScore < ZHU_V1.thresholds.minScore) continue;

      // ── Layer 1b: KD 方向 + 上影線 ──
      const kd = candles[idx].indicators?.kd;
      const prevKd = candles[idx - 1]?.indicators?.kd;
      if (kd && prevKd && kd.k < prevKd.k) continue;

      const c = candles[idx];
      const bodySize = Math.abs(c.close - c.open);
      const totalRange = c.high - c.low;
      if (totalRange > 0) {
        const upperShadow = c.high - Math.max(c.open, c.close);
        if (upperShadow / totalRange > 0.5) continue;
      }

      // ── Layer 2: 十戒律 ──
      try {
        const prohib = checkLongProhibitions(candles, idx);
        if (prohib.isProhibited) continue;
      } catch { continue; }

      // ── Layer 3: 淘汰法 ──
      try {
        const elim = evaluateElimination(candles, idx);
        if (elim.isEliminated) continue;
      } catch { continue; }

      // ── Layer 0: MTF 分數（只記錄，不篩選）──
      let mtfScore = 0;
      try {
        const mtf = evaluateMultiTimeframe(candles, idx);
        mtfScore = mtf.totalScore;
      } catch { /* default 0 */ }

      // ── 計算後續 1~5 日漲幅（用收盤價）──
      const entryPrice = c.close;
      const getDayReturn = (offset: number): number | null => {
        const futureIdx = idx + offset;
        if (futureIdx >= candles.length) return null;
        return +((candles[futureIdx].close - entryPrice) / entryPrice * 100).toFixed(2);
      };

      results.push({
        mtfScore,
        day1: getDayReturn(1),
        day2: getDayReturn(2),
        day3: getDayReturn(3),
        day4: getDayReturn(4),
        day5: getDayReturn(5),
      });
    }
  }

  console.log(`\n   總候選股: ${results.length} 筆\n`);

  // ── 按 MTF 分數分組統計 ──
  const groups: Record<number, CandidateReturn[]> = { 0: [], 1: [], 2: [], 3: [], 4: [] };
  for (const r of results) {
    groups[r.mtfScore]?.push(r);
  }

  // ── 各 MTF 分數的基本統計 ──
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  1. 各 MTF 分數的後續漲幅統計');
  console.log('═══════════════════════════════════════════════════════════\n');

  const dayLabels = ['1日後', '2日後', '3日後', '4日後', '5日後'];
  const dayKeys: (keyof CandidateReturn)[] = ['day1', 'day2', 'day3', 'day4', 'day5'];

  for (const day of [0, 1, 2, 3, 4]) {
    const key = dayKeys[day];
    console.log(`  【${dayLabels[day]}漲幅】`);
    console.log('  MTF   筆數     均報     中位數   勝率    >5%    >10%   >20%   >50%   最大漲幅');
    console.log('  ' + '─'.repeat(85));

    for (let mtf = 0; mtf <= 4; mtf++) {
      const vals = groups[mtf].map(r => r[key]).filter((v): v is number => v !== null);
      if (vals.length === 0) continue;

      vals.sort((a, b) => a - b);
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      const median = vals[Math.floor(vals.length / 2)];
      const winRate = vals.filter(v => v > 0).length / vals.length * 100;
      const gt5 = vals.filter(v => v > 5).length;
      const gt10 = vals.filter(v => v > 10).length;
      const gt20 = vals.filter(v => v > 20).length;
      const gt50 = vals.filter(v => v > 50).length;
      const max = vals[vals.length - 1];

      console.log(
        `  MTF=${mtf}` +
        `${vals.length.toString().padStart(7)}` +
        `${(avg >= 0 ? '+' : '') + avg.toFixed(2) + '%'}`.padStart(9) +
        `${(median >= 0 ? '+' : '') + median.toFixed(2) + '%'}`.padStart(10) +
        `${winRate.toFixed(0) + '%'}`.padStart(7) +
        `${gt5}`.padStart(7) +
        `${gt10}`.padStart(7) +
        `${gt20}`.padStart(7) +
        `${gt50}`.padStart(7) +
        `  ${max >= 0 ? '+' : ''}${max.toFixed(2)}%`
      );
    }
    console.log('');
  }

  // ── MTF 門檻累積統計（≥N）──
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  2. MTF 門檻累積統計（≥N 的候選股）');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const day of [0, 4]) {  // 只看 1日後 和 5日後
    const key = dayKeys[day];
    console.log(`  【${dayLabels[day]}漲幅 — 累積門檻】`);
    console.log('  門檻    筆數     均報     勝率    >10%   >20%   >50%   被篩掉的>20%股票');
    console.log('  ' + '─'.repeat(75));

    const allVals = results.map(r => r[key]).filter((v): v is number => v !== null);
    const allGt20 = results.filter(r => {
      const v = r[key];
      return v !== null && v > 20;
    });

    for (let threshold = 0; threshold <= 4; threshold++) {
      const filtered = results.filter(r => r.mtfScore >= threshold);
      const vals = filtered.map(r => r[key]).filter((v): v is number => v !== null);
      if (vals.length === 0) continue;

      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      const winRate = vals.filter(v => v > 0).length / vals.length * 100;
      const gt10 = vals.filter(v => v > 10).length;
      const gt20 = vals.filter(v => v > 20).length;
      const gt50 = vals.filter(v => v > 50).length;

      // 被篩掉的 >20% 股票
      const filteredOut20 = allGt20.filter(r => r.mtfScore < threshold).length;
      const filteredOutPct = allGt20.length > 0
        ? (filteredOut20 / allGt20.length * 100).toFixed(1)
        : '0.0';

      console.log(
        `  MTF≥${threshold}` +
        `${vals.length.toString().padStart(7)}` +
        `${(avg >= 0 ? '+' : '') + avg.toFixed(2) + '%'}`.padStart(9) +
        `${winRate.toFixed(0) + '%'}`.padStart(7) +
        `${gt10}`.padStart(7) +
        `${gt20}`.padStart(7) +
        `${gt50}`.padStart(7) +
        `   篩掉 ${filteredOut20}/${allGt20.length} (${filteredOutPct}%)`
      );
    }
    console.log('');
  }

  // ── 被 MTF≥3 篩掉的大漲股票列表 ──
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  3. 被 MTF≥3 篩掉的大漲股票（5日後漲幅 >20%）');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Need to re-collect with stock info
  // For this section, we'll just show the count and MTF distribution
  const day5Big = results.filter(r => r.day5 !== null && r.day5 > 20);
  const mtfDist: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of day5Big) {
    mtfDist[r.mtfScore] = (mtfDist[r.mtfScore] || 0) + 1;
  }

  console.log(`  5日後漲幅 >20% 的股票共 ${day5Big.length} 筆`);
  console.log('  MTF 分數分佈：');
  for (let mtf = 0; mtf <= 4; mtf++) {
    const count = mtfDist[mtf] || 0;
    const pct = day5Big.length > 0 ? (count / day5Big.length * 100).toFixed(1) : '0.0';
    const bar = '█'.repeat(Math.round(count / 2));
    console.log(`    MTF=${mtf}: ${count.toString().padStart(4)} 筆 (${pct.padStart(5)}%)  ${bar}`);
  }

  const filteredByMtf3 = day5Big.filter(r => r.mtfScore < 3).length;
  const filteredByMtf4 = day5Big.filter(r => r.mtfScore < 4).length;
  console.log(`\n  MTF≥3 會篩掉: ${filteredByMtf3}/${day5Big.length} 筆大漲股 (${(filteredByMtf3/day5Big.length*100).toFixed(1)}%)`);
  console.log(`  MTF≥4 會篩掉: ${filteredByMtf4}/${day5Big.length} 筆大漲股 (${(filteredByMtf4/day5Big.length*100).toFixed(1)}%)`);

  console.log('\n  ✅ 如果篩掉比例低 → MTF 沒有把大漲股過濾掉，安全使用');
  console.log('  ❌ 如果篩掉比例高 → MTF 門檻太高會錯過機會\n');
}

main().catch(console.error);
