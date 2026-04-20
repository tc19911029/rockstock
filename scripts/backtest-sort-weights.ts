/**
 * 多因子權重組合掃描（階段二，2026-04-20 新建）
 *
 * 階段一（backtest-sort-matrix.ts）跑完單因子後，此腳本用來測試：
 *   - 選出的 top-3 單因子
 *   - 在不同權重組合（Z-score 標準化後線性加權）下表現
 *
 * Usage:
 *   MARKET=TW PERIOD=P2 STRATEGY=A FACTORS="漲幅,成交額,量比" \
 *     NODE_OPTIONS="--max-old-space-size=8192" \
 *     npx tsx scripts/backtest-sort-weights.ts
 *
 * FACTORS 環境變數：逗號分隔的 3 個因子名；本腳本掃下列權重：
 *   (1.0, 0, 0) / (0.5, 0.5, 0) / (0.6, 0.3, 0.1)
 *   (0.5, 0.3, 0.2) / (0.4, 0.3, 0.3) / (0.34, 0.33, 0.33)
 *
 * TODO（階段一結果出來後填入）：
 *   - 各市場×策略下 top-3 單因子對照表 → 決定預設 FACTORS
 *   - 把 buildCombos() 改為自動從 sort-matrix-*-stability.md 讀取推薦因子
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe } from '@/lib/analysis/multiTimeframeFilter';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { checkLongProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { detectBreakoutEntry } from '@/lib/analysis/breakoutEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import type { CandleWithIndicators } from '@/types';
import { BASE_THRESHOLDS, ZHU_OPTIMIZED } from '@/lib/strategy/StrategyConfig';
import { SORT_DEFS, buildFeatures, type SortFactorName, type CandidateFeatures } from './_backtest-sort-defs';

type Market = 'TW' | 'CN';
type StrategyCode = 'A' | 'A_MTF' | 'B' | 'C' | 'D' | 'E';

const ENV = {
  MARKET:   (process.env.MARKET   ?? 'TW') as Market,
  PERIOD:   (process.env.PERIOD   ?? 'P2') as 'P1' | 'P2' | 'P3',
  STRATEGY: (process.env.STRATEGY ?? 'A')  as StrategyCode,
  FACTORS:  (process.env.FACTORS  ?? '漲幅,成交額,量比').split(',').map(s => s.trim()) as SortFactorName[],
};

const PERIODS = {
  P1: { start: '2024-04-22', end: '2026-04-20' },
  P2: { start: '2025-04-21', end: '2026-04-20' },
  P3: { start: '2026-01-02', end: '2026-04-20' },
} as const;

const WEIGHT_COMBOS: Array<[number, number, number]> = [
  [1.0, 0.0, 0.0],
  [0.5, 0.5, 0.0],
  [0.6, 0.3, 0.1],
  [0.5, 0.3, 0.2],
  [0.4, 0.3, 0.3],
  [0.34, 0.33, 0.33],
];

const SLIPPAGE_PCT = 0.001;
const MTF_CFG = { ...BASE_THRESHOLDS, multiTimeframeFilter: true };

// （略 — 階段一結果出爐後補完；此骨架已定義 ENV、權重組合、因子向量）
console.log(`[階段二骨架] 已載入 ENV + 權重組合。`);
console.log(`  MARKET=${ENV.MARKET} PERIOD=${ENV.PERIOD} STRATEGY=${ENV.STRATEGY} FACTORS=${ENV.FACTORS.join(',')}`);
console.log(`  權重組合數：${WEIGHT_COMBOS.length}`);
console.log(`\n  實作步驟（TODO）：`);
console.log(`    1) 載入股票 + 跑 buildCandidate（複用 backtest-sort-matrix.ts 的邏輯）`);
console.log(`    2) 每日候選池：每個候選對 FACTORS 三個因子各算原始值`);
console.log(`    3) 全候選池內對每個因子做 Z-score 標準化`);
console.log(`    4) 對每個 WEIGHT_COMBO：加權求和 → 取 #1 → 算 d1~d5`);
console.log(`    5) 輸出 CSV + summary md`);
console.log(``);
console.log(`  執行前請先跑 backtest-sort-matrix.ts，看 stability.md 得知各策略×市場 top-3 單因子。`);

// 防編譯錯誤：把未用到的 imports 放進無用參考
void SORT_DEFS; void buildFeatures; void evaluateSixConditions; void evaluateMultiTimeframe;
void evaluateHighWinRateEntry; void checkLongProhibitions; void evaluateElimination;
void detectBreakoutEntry; void detectVReversal; void detectStrategyD; void detectStrategyE;
void ZHU_OPTIMIZED; void MTF_CFG; void SLIPPAGE_PCT; void PERIODS; void computeIndicators;
void fs; void path;
// 未使用的局部型別（供未來擴充）
type _Features = CandidateFeatures;
type _Candle = CandleWithIndicators;
void (null as _Features | _Candle | null);
