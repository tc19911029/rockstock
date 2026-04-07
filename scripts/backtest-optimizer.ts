/**
 * Backtest Optimizer — Layer 0 門檻 + 排序權重最佳化
 *
 * 核心目標：找出最佳的 MTF 門檻與排序因子權重，
 * 讓每天排名第1的股票長期最賺錢。
 *
 * 賣出規則：朱家泓 SOP 獲利方程式（動態停損 + 利潤方程式 + 20日安全網）
 * 進場方式：隔日開盤價
 *
 * Phase A: 單因子排序能力測試
 * Phase B: MTF 門檻測試 (≥0, ≥1, ≥2, ≥3, =4)
 * Phase C: 權重組合網格搜索 (13 combos × 5 thresholds)
 * Phase D: 對照組比較 + Spearman 相關性
 * Walk-Forward: 訓練/驗證分割驗證
 *
 * Usage:
 *   npx tsx scripts/backtest-optimizer.ts                     # 台股
 *   npx tsx scripts/backtest-optimizer.ts --market CN         # 陸股
 *   npx tsx scripts/backtest-optimizer.ts --output result.json
 */
import fs from 'fs';
import path from 'path';
import {
  loadAndPrepare,
  collectAllCandidates,
} from '../lib/backtest/optimizer/candidateCollector';
import type { CacheData } from '../lib/backtest/optimizer/candidateCollector';
import {
  runPhaseA,
  runPhaseB,
  runPhaseC,
  runPhaseD,
  runWalkForward,
} from '../lib/backtest/optimizer/phaseRunner';
import {
  printPhaseA,
  printPhaseB,
  printPhaseC,
  printPhaseD,
  printWalkForward,
  printDailyDetail,
  exportJson,
} from '../lib/backtest/optimizer/outputFormatter';
import type { OptimizerConfig } from '../lib/backtest/optimizer/types';

// ── Config ──────────────────────────────────────────────────────────────────────

const BACKTEST_START = '2025-04-01';
const BACKTEST_MID   = '2025-10-01';   // 訓練/驗證分界
const BACKTEST_END   = '2026-04-04';

const TW_BENCHMARKS = ['2330.TW', '2317.TW', '2454.TW'];
const CN_BENCHMARKS = ['600519.SS', '601318.SS', '000001.SZ'];

// ── Parse CLI Args ──────────────────────────────────────────────────────────────

const marketIdx = process.argv.indexOf('--market');
const market = marketIdx >= 0 ? (process.argv[marketIdx + 1] ?? 'TW') : 'TW';

const outputIdx = process.argv.indexOf('--output');
const outputPath = outputIdx >= 0 ? process.argv[outputIdx + 1] : null;

const label = market === 'CN' ? '陸股' : '台股';
const benchmarks = market === 'CN' ? CN_BENCHMARKS : TW_BENCHMARKS;

const cacheFile = path.join(process.cwd(), 'data',
  market === 'CN' ? 'backtest-candles-cn.json' : 'backtest-candles.json');

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  回測優化器：Layer 0 門檻 + 排序權重最佳化（${label}）`);
  console.log('  進場：當日收盤價');
  console.log('  出場：朱家泓 SOP 獲利方程式（完整版）');
  console.log(`  期間：${BACKTEST_START} ~ ${BACKTEST_END}`);
  console.log(`  訓練/驗證分界：${BACKTEST_MID}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── 載入資料 ──
  if (!fs.existsSync(cacheFile)) {
    console.error(`❌ 找不到快取 ${cacheFile}`);
    return;
  }

  console.log('📦 載入快取...');
  const raw: CacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  console.log(`   快取時間: ${raw.savedAt}`);

  const data = loadAndPrepare(
    raw,
    benchmarks,
    market as 'TW' | 'CN',
    BACKTEST_START,
    BACKTEST_END,
  );
  console.log(`   ${data.allCandles.size} 支股票`);
  console.log(`   ${data.tradingDays.length} 個交易日\n`);

  // ── Phase 0: 收集候選股 + SOP 交易模擬 ──
  console.log('══ Phase 0: 收集候選股 + SOP 交易模擬 ══\n');
  const dailyCandidates = collectAllCandidates(data);

  // 統計
  let totalCandidates = 0;
  let totalWithTrade = 0;
  for (const [, candidates] of dailyCandidates) {
    totalCandidates += candidates.length;
    totalWithTrade += candidates.filter(c => c.tradeResult != null).length;
  }
  console.log(`\n   候選股總計: ${totalCandidates} 筆`);
  console.log(`   有交易結果: ${totalWithTrade} 筆 (${(totalWithTrade / totalCandidates * 100).toFixed(1)}%)`);
  console.log(`   平均每日: ${(totalCandidates / data.tradingDays.length).toFixed(1)} 檔\n`);

  const allDays   = data.tradingDays;
  const trainDays = allDays.filter(d => d < BACKTEST_MID);
  const testDays  = allDays.filter(d => d >= BACKTEST_MID);

  console.log(`   訓練期: ${trainDays.length} 天`);
  console.log(`   驗證期: ${testDays.length} 天`);

  // ── Phase A ──
  const phaseA = runPhaseA(dailyCandidates, allDays);
  printPhaseA(phaseA);

  // ── Phase B ──
  const phaseB = runPhaseB(dailyCandidates, allDays);
  printPhaseB(phaseB);

  // ── Phase C ──
  const phaseC = runPhaseC(dailyCandidates, allDays);
  printPhaseC(phaseC);

  // ── Phase D ──
  const bestFromC = phaseC.top10[0];
  const phaseD = runPhaseD(
    dailyCandidates, allDays,
    bestFromC.combo, bestFromC.threshold,
  );
  printPhaseD(phaseD);

  // ── Walk-Forward ──
  const walkForward = runWalkForward(dailyCandidates, trainDays, testDays);
  printWalkForward(walkForward);

  // ── 最佳策略每日明細 ──
  // 同時輸出兩個策略：Phase C 冠軍 + MTF≥3 + 1:2（最穩）
  const bestThreshold = bestFromC.threshold;
  const bestCombo     = bestFromC.combo;
  const dailyDetail   = printDailyDetail(
    dailyCandidates, allDays,
    bestCombo, bestThreshold,
  );

  // 額外輸出 MTF≥0 + 1:1 的明細（如果不是冠軍的話）
  const stableCombo = { name: '1:1', wR: 1, wH: 1, wM: 0 };
  const stableThreshold = 0;
  const isAlreadyBest = bestThreshold === stableThreshold && bestCombo.name === stableCombo.name;
  const stableDetail = isAlreadyBest ? dailyDetail : printDailyDetail(
    dailyCandidates, allDays,
    stableCombo, stableThreshold,
  );

  // ── JSON 匯出 ──
  const config: OptimizerConfig = {
    market: market as 'TW' | 'CN',
    backtestStart: BACKTEST_START,
    backtestMid:   BACKTEST_MID,
    backtestEnd:   BACKTEST_END,
    outputJson:    outputPath,
  };

  if (outputPath) {
    exportJson(
      outputPath,
      config,
      phaseA, phaseB, phaseC, phaseD,
      walkForward,
      { mtfThreshold: bestThreshold, combo: bestCombo, metrics: bestFromC.metrics },
      dailyDetail,
    );
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n⏱  總耗時: ${elapsed} 秒`);
}

main().catch(console.error);
