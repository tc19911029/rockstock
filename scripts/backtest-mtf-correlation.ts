/**
 * 回測：MTF 分數(0-4) vs 六條件選股報酬的相關性
 *
 * 通過六條件的股票，按 MTF 分數分 5 組（0/1/2/3/4），
 * 分別統計 1D-10D 漲跌幅，觀察分數與報酬是否正相關。
 *
 * Usage:
 *   npx tsx scripts/backtest-mtf-correlation.ts              # 台股
 *   npx tsx scripts/backtest-mtf-correlation.ts --market CN  # 陸股
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators } from '../lib/indicators';
import { evaluateSixConditions } from '../lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe } from '../lib/analysis/multiTimeframeFilter';
import { ZHU_V1 } from '../lib/strategy/StrategyConfig';
import type { CandleWithIndicators, Candle } from '../types';

const thresholds = ZHU_V1.thresholds;

const BACKTEST_START = '2024-04-01';
const BACKTEST_END   = '2026-04-04';
const FORWARD_DAYS   = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const MTF_SCORES     = [0, 1, 2, 3, 4];

// ── Parse args ───────────────────────────────────────────────────────────────
const marketIdx = process.argv.indexOf('--market');
const market = marketIdx >= 0 ? (process.argv[marketIdx + 1] ?? 'TW') : 'TW';
const label = market === 'CN' ? '陸股' : '台股';

const cacheFile = path.join(process.cwd(), 'data',
  market === 'CN' ? 'backtest-candles-cn.json' : 'backtest-candles.json');

const benchmarks = market === 'CN'
  ? ['600519.SS', '601318.SS', '000001.SZ']
  : ['2330.TW', '2317.TW', '2454.TW'];

interface CacheData {
  savedAt: string;
  stocks: Record<string, { name: string; candles: Candle[] }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function findDateIndex(candles: CandleWithIndicators[], targetDate: string): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    const d = candles[i].date?.slice(0, 10);
    if (d && d <= targetDate) return i;
  }
  return -1;
}

function forwardReturn(candles: CandleWithIndicators[], idx: number, days: number): number | null {
  const exit = idx + days;
  if (exit >= candles.length) return null;
  const entry = candles[idx].close;
  if (!entry || entry <= 0) return null;
  return +((candles[exit].close - entry) / entry * 100).toFixed(2);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  回測：MTF 分數 vs 報酬相關性（${label}）`);
  console.log(`  期間：${BACKTEST_START} ~ ${BACKTEST_END}`);
  console.log(`  MTF 分數 0-4，各組 1D-10D 漲跌幅`);
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

  // 取交易日
  let benchCandles: CandleWithIndicators[] | undefined;
  for (const s of benchmarks) {
    benchCandles = allCandles.get(s)?.candles;
    if (benchCandles && benchCandles.length > 100) break;
  }
  if (!benchCandles) { console.error('❌ 找不到基準股'); return; }

  const tradingDays = benchCandles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);

  console.log(`📅 回測期間共 ${tradingDays.length} 個交易日\n`);

  // 5 組 bucket，每組有 10 個天期的 returns 陣列
  const buckets: Map<number, number[][]> = new Map();
  for (const score of MTF_SCORES) {
    buckets.set(score, FORWARD_DAYS.map(() => []));
  }

  let dayCount = 0;
  for (const date of tradingDays) {
    dayCount++;
    if (dayCount % 20 === 0) {
      console.log(`   處理進度：${dayCount}/${tradingDays.length} 天`);
    }

    for (const [, data] of allCandles) {
      const idx = findDateIndex(data.candles, date);
      if (idx < 60) continue;
      if (data.candles[idx].date?.slice(0, 10) !== date) continue;

      // 先過六條件
      const sixConds = evaluateSixConditions(data.candles, idx, thresholds);
      if (!sixConds.isCoreReady) continue;

      // 計算 MTF 分數
      const mtf = evaluateMultiTimeframe(
        data.candles.slice(0, idx + 1),
        thresholds,
      );
      const score = Math.min(mtf.totalScore, 4); // clamp to 0-4

      // forward returns
      const rets = FORWARD_DAYS.map(d => forwardReturn(data.candles, idx, d));
      const bucket = buckets.get(score)!;
      for (let i = 0; i < FORWARD_DAYS.length; i++) {
        if (rets[i] != null) bucket[i].push(rets[i]!);
      }
    }
  }

  // ── 輸出各組詳細結果 ──
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  各 MTF 分數組的 1D-10D 表現`);
  console.log(`═══════════════════════════════════════════════════\n`);

  for (const score of MTF_SCORES) {
    const bucket = buckets.get(score)!;
    const totalSamples = bucket[0].length;
    console.log(`📊 MTF=${score}  （${totalSamples} 筆）`);

    if (totalSamples === 0) {
      console.log('   （無數據）\n');
      continue;
    }

    for (let i = 0; i < FORWARD_DAYS.length; i++) {
      const arr = bucket[i];
      if (arr.length === 0) continue;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      const med = median(arr);
      const winRate = arr.filter(r => r > 0).length / arr.length * 100;
      console.log(
        `   ${FORWARD_DAYS[i].toString().padStart(2)}日  ` +
        `平均: ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%  ` +
        `中位數: ${med >= 0 ? '+' : ''}${med.toFixed(2)}%  ` +
        `勝率: ${winRate.toFixed(1)}%`
      );
    }
    console.log('');
  }

  // ── 相關性摘要表 ──
  console.log(`═══════════════════════════════════════════════════`);
  console.log(`  相關性摘要（MTF分數 → 報酬）`);
  console.log(`═══════════════════════════════════════════════════\n`);

  const keyDays = [0, 2, 4, 9]; // 1D, 3D, 5D, 10D
  const headers = ['MTF分數', '樣本數', ...keyDays.map(i => `${FORWARD_DAYS[i]}D均報`), ...keyDays.map(i => `${FORWARD_DAYS[i]}D勝率`)];
  console.log(headers.map(h => h.padStart(8)).join(''));

  for (const score of MTF_SCORES) {
    const bucket = buckets.get(score)!;
    const n = bucket[0].length;
    const avgs = keyDays.map(i => {
      const arr = bucket[i];
      if (arr.length === 0) return '   N/A';
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      return `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`.padStart(8);
    });
    const wins = keyDays.map(i => {
      const arr = bucket[i];
      if (arr.length === 0) return '   N/A';
      const w = arr.filter(r => r > 0).length / arr.length * 100;
      return `${w.toFixed(1)}%`.padStart(8);
    });
    console.log(`${score.toString().padStart(8)}${n.toString().padStart(8)}${avgs.join('')}${wins.join('')}`);
  }

  // 計算趨勢方向
  console.log('\n📈 趨勢判斷：');
  for (const di of keyDays) {
    const dayLabel = `${FORWARD_DAYS[di]}D`;
    const points: { score: number; avg: number }[] = [];
    for (const score of MTF_SCORES) {
      const arr = buckets.get(score)![di];
      if (arr.length < 10) continue;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      points.push({ score, avg });
    }
    if (points.length < 3) { console.log(`   ${dayLabel}: 數據不足`); continue; }

    // 簡單線性趨勢：看首尾差
    const first = points[0];
    const last = points[points.length - 1];
    const diff = last.avg - first.avg;
    const direction = diff > 0.1 ? '正相關 ↑' : diff < -0.1 ? '負相關 ↓' : '無明顯相關 ─';
    console.log(`   ${dayLabel}: MTF ${first.score}→${last.score} 均報 ${first.avg >= 0 ? '+' : ''}${first.avg.toFixed(2)}% → ${last.avg >= 0 ? '+' : ''}${last.avg.toFixed(2)}%  ${direction}`);
  }
  console.log('');
}

main().catch(console.error);
