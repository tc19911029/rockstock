/**
 * 回測：長線保護短線(MTF) + 六大進場條件 → 1D~10D 漲跌幅
 *
 * 測試「通過MTF+六條件的股票」vs「只通過六條件的股票」的表現差異
 *
 * Usage:
 *   npx tsx scripts/backtest-mtf-six.ts              # 台股
 *   npx tsx scripts/backtest-mtf-six.ts --market CN  # 陸股
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators } from '../lib/indicators';
import { evaluateSixConditions } from '../lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe } from '../lib/analysis/multiTimeframeFilter';
import { ZHU_V1 } from '../lib/strategy/StrategyConfig';
import type { CandleWithIndicators, Candle } from '../types';

const thresholds = ZHU_V1.thresholds;

// ── Config ───────────────────────────────────────────────────────────────────
const BACKTEST_START = '2024-04-01';
const BACKTEST_END   = '2026-04-04';
const FORWARD_DAYS   = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// ── Parse args ───────────────────────────────────────────────────────────────
const marketIdx = process.argv.indexOf('--market');
const market = marketIdx >= 0 ? (process.argv[marketIdx + 1] ?? 'TW') : 'TW';
const label = market === 'CN' ? '陸股' : '台股';

const cacheFile = path.join(process.cwd(), 'data',
  market === 'CN' ? 'backtest-candles-cn.json' : 'backtest-candles.json');

const benchmarks = market === 'CN'
  ? ['600519.SS', '601318.SS', '000001.SZ']
  : ['2330.TW', '2317.TW', '2454.TW'];

// ── Types ────────────────────────────────────────────────────────────────────
interface CacheData {
  savedAt: string;
  stocks: Record<string, { name: string; candles: Candle[] }>;
}

interface PickResult {
  symbol: string;
  name: string;
  returns: (number | null)[];  // index 0 = 1D, index 9 = 10D
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  回測：MTF + 六條件 → 1D~10D 漲跌幅（${label}）`);
  console.log(`  期間：${BACKTEST_START} ~ ${BACKTEST_END}`);
  console.log(`═══════════════════════════════════════════════════\n`);

  if (!fs.existsSync(cacheFile)) {
    console.error(`❌ 找不到快取 ${cacheFile}，請先跑 backtest-ranking-weights.ts`);
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

  // ── 兩組統計 ──
  // A組：只通過六條件（isCoreReady）
  // B組：通過六條件 + MTF（長線保護短線）
  const statsA: { returns: number[][] } = { returns: FORWARD_DAYS.map(() => []) };
  const statsB: { returns: number[][] } = { returns: FORWARD_DAYS.map(() => []) };

  let dayCount = 0;
  for (const date of tradingDays) {
    dayCount++;
    if (dayCount % 20 === 0) {
      console.log(`   處理進度：${dayCount}/${tradingDays.length} 天`);
    }

    for (const [symbol, data] of allCandles) {
      const idx = findDateIndex(data.candles, date);
      if (idx < 60) continue;
      if (data.candles[idx].date?.slice(0, 10) !== date) continue;

      // 六條件
      const sixConds = evaluateSixConditions(data.candles, idx, thresholds);
      if (!sixConds.isCoreReady) continue;

      // 計算 forward returns
      const rets = FORWARD_DAYS.map(d => forwardReturn(data.candles, idx, d));

      // A組：通過六條件就算
      for (let i = 0; i < FORWARD_DAYS.length; i++) {
        if (rets[i] != null) statsA.returns[i].push(rets[i]!);
      }

      // B組：額外要通過 MTF
      const mtf = evaluateMultiTimeframe(
        data.candles.slice(0, idx + 1),  // 只傳到當天的數據
        thresholds,
      );
      if (mtf.pass) {
        for (let i = 0; i < FORWARD_DAYS.length; i++) {
          if (rets[i] != null) statsB.returns[i].push(rets[i]!);
        }
      }
    }
  }

  // ── 輸出結果 ──
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  結果`);
  console.log(`═══════════════════════════════════════════════════\n`);

  function printStats(name: string, stats: { returns: number[][] }) {
    console.log(`📊 ${name}`);
    for (let i = 0; i < FORWARD_DAYS.length; i++) {
      const arr = stats.returns[i];
      if (arr.length === 0) {
        console.log(`   ${FORWARD_DAYS[i].toString().padStart(2)}日  — 無數據`);
        continue;
      }
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      const winRate = arr.filter(r => r > 0).length / arr.length * 100;
      const median = arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
      console.log(
        `   ${FORWARD_DAYS[i].toString().padStart(2)}日  — ` +
        `平均: ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%  ` +
        `中位數: ${median >= 0 ? '+' : ''}${median.toFixed(2)}%  ` +
        `勝率: ${winRate.toFixed(1)}%  ` +
        `(${arr.length}筆)`
      );
    }
    console.log('');
  }

  printStats(`A組：只用六條件（無MTF）`, statsA);
  printStats(`B組：六條件 + MTF長線保護短線`, statsB);

  // ── 差異比較 ──
  console.log(`📈 B組 vs A組 差異（MTF 的增量效果）`);
  console.log(`   天期  平均報酬差  勝率差    樣本比`);
  for (let i = 0; i < FORWARD_DAYS.length; i++) {
    const a = statsA.returns[i];
    const b = statsB.returns[i];
    if (a.length === 0 || b.length === 0) continue;
    const avgA = a.reduce((s, v) => s + v, 0) / a.length;
    const avgB = b.reduce((s, v) => s + v, 0) / b.length;
    const winA = a.filter(r => r > 0).length / a.length * 100;
    const winB = b.filter(r => r > 0).length / b.length * 100;
    const diff = avgB - avgA;
    const winDiff = winB - winA;
    const ratio = (b.length / a.length * 100).toFixed(0);
    console.log(
      `   ${FORWARD_DAYS[i].toString().padStart(2)}日   ` +
      `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%     ` +
      `${winDiff >= 0 ? '+' : ''}${winDiff.toFixed(1)}%    ` +
      `${ratio}%（${b.length}/${a.length}）`
    );
  }
  console.log('');
}

main().catch(console.error);
