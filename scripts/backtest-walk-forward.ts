/**
 * Phase 2: Walk-Forward 樣本外驗證
 *
 * 從 scan-{market}-long-daily-{date}.json 構造 WalkForwardSession，
 * 跑 runWalkForward 看 efficiencyRatio + robustnessScore。
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-walk-forward.ts
 *
 * 環境變數：
 *   MARKET=TW|CN        只跑單一市場（預設兩個都跑）
 *   TRAIN_SIZE=30       訓練窗 sessions 數（預設 30）
 *   TEST_SIZE=10        測試窗 sessions 數（預設 10）
 *   STEP_SIZE=10        滾動步進（預設 10）
 *   FORWARD_DAYS=15     forward candles 取幾天（預設 15，cover 到 d10 + 緩衝）
 *   HOLD_DAYS=5         策略持有天數（預設 5）
 *
 * 輸出：
 *   data/backtest_walk_forward.json
 *   docs/audit/2026-05-22-baseline-kpi.md（附加第 2 節）
 */

import fs from 'fs';
import path from 'path';
import { runWalkForward, type WalkForwardSession } from '@/lib/backtest/WalkForwardTest';
import { DEFAULT_STRATEGY, type BacktestStrategyParams } from '@/lib/backtest/BacktestEngine';
import type { StockScanResult, ForwardCandle, MarketId } from '@/lib/scanner/types';

// ════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════

const CONFIG = {
  market:       (process.env.MARKET as 'TW' | 'CN' | undefined),
  trainSize:    Number(process.env.TRAIN_SIZE ?? 30),
  testSize:     Number(process.env.TEST_SIZE ?? 10),
  stepSize:     Number(process.env.STEP_SIZE ?? 10),
  forwardDays:  Number(process.env.FORWARD_DAYS ?? 15),
  holdDays:     Number(process.env.HOLD_DAYS ?? 5),
};

const ROOT       = path.join(process.cwd(), 'data');
const CANDLE_ROOT = path.join(ROOT, 'candles');
const OUT_JSON   = path.join(ROOT, 'backtest_walk_forward.json');

// ════════════════════════════════════════════════════════════════
// Load scan blob (daily session)
// ════════════════════════════════════════════════════════════════

interface ScanFile { results?: StockScanResult[] }

function listDailySessions(market: 'TW' | 'CN'): string[] {
  const re = new RegExp(`^scan-${market}-long-daily-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
  return fs.readdirSync(ROOT)
    .map(f => f.match(re))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => m[1])
    .sort();
}

function loadScanResults(market: 'TW' | 'CN', date: string): StockScanResult[] {
  const file = path.join(ROOT, `scan-${market}-long-daily-${date}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8')) as ScanFile;
    return d.results ?? [];
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════════════════
// Load L1 candles + build ForwardCandle[] with MA
// ════════════════════════════════════════════════════════════════

interface RawCandle { date: string; open: number; high: number; low: number; close: number; volume: number }

const candleCache = new Map<string, RawCandle[] | null>();

function loadCandles(market: 'TW' | 'CN', symbol: string): RawCandle[] | null {
  const key = `${market}|${symbol}`;
  if (candleCache.has(key)) return candleCache.get(key)!;
  const file = path.join(CANDLE_ROOT, market, `${symbol}.json`);
  if (!fs.existsSync(file)) { candleCache.set(key, null); return null; }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.candles ?? []);
    const norm: RawCandle[] = arr
      .map((c: { date?: string; open?: number; high?: number; low?: number; close?: number; volume?: number }) => ({
        date:   (c.date ?? '').slice(0, 10),
        open:   Number(c.open)   || 0,
        high:   Number(c.high)   || 0,
        low:    Number(c.low)    || 0,
        close:  Number(c.close)  || 0,
        volume: Number(c.volume) || 0,
      }))
      .filter((c: RawCandle) => c.date && c.close > 0)
      .sort((a: RawCandle, b: RawCandle) => a.date.localeCompare(b.date));
    candleCache.set(key, norm);
    return norm;
  } catch {
    candleCache.set(key, null);
    return null;
  }
}

function smaAt(candles: RawCandle[], idx: number, period: number): number | undefined {
  if (idx + 1 < period) return undefined;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) sum += candles[i].close;
  return sum / period;
}

function buildForwardCandles(market: 'TW' | 'CN', symbol: string, signalDate: string): ForwardCandle[] {
  const candles = loadCandles(market, symbol);
  if (!candles) return [];
  const t0 = candles.findIndex(c => c.date === signalDate);
  if (t0 < 0) return [];
  const out: ForwardCandle[] = [];
  // forwardCandles 從訊號日「之後」開始（隔日為 entry）
  for (let i = t0 + 1; i <= Math.min(t0 + CONFIG.forwardDays, candles.length - 1); i++) {
    const c = candles[i];
    out.push({
      date: c.date,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      ma5:  smaAt(candles, i, 5),
      ma10: smaAt(candles, i, 10),
      ma20: smaAt(candles, i, 20),
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// Build sessions
// ════════════════════════════════════════════════════════════════

function buildSessions(market: 'TW' | 'CN'): WalkForwardSession[] {
  const dates = listDailySessions(market);
  console.log(`  [${market}] daily session 檔案：${dates.length} 天`);

  const sessions: WalkForwardSession[] = [];
  for (const date of dates) {
    const results = loadScanResults(market, date);
    if (results.length === 0) continue;

    const forwardCandlesMap: Record<string, ForwardCandle[]> = {};
    for (const r of results) {
      if (forwardCandlesMap[r.symbol]) continue;
      const candles = buildForwardCandles(market, r.symbol, date);
      if (candles.length > 0) forwardCandlesMap[r.symbol] = candles;
    }

    sessions.push({ date, scanResults: results, forwardCandlesMap });
  }
  console.log(`  [${market}] 構造 ${sessions.length} 個 session`);
  return sessions;
}

// ════════════════════════════════════════════════════════════════
// Run walk-forward
// ════════════════════════════════════════════════════════════════

function runForMarket(market: 'TW' | 'CN'): {
  market: MarketId;
  sessionsCount: number;
  result: ReturnType<typeof runWalkForward> | null;
  error: string | null;
} {
  const sessions = buildSessions(market);
  const minRequired = CONFIG.trainSize + CONFIG.testSize;
  if (sessions.length < minRequired) {
    return {
      market,
      sessionsCount: sessions.length,
      result: null,
      error: `sessions=${sessions.length} < 必要 ${minRequired}（train ${CONFIG.trainSize} + test ${CONFIG.testSize}）`,
    };
  }

  const strategy: BacktestStrategyParams = {
    ...DEFAULT_STRATEGY,
    holdDays: CONFIG.holdDays,
  };

  console.log(`  [${market}] 跑 WalkForward (train=${CONFIG.trainSize}, test=${CONFIG.testSize}, step=${CONFIG.stepSize})...`);
  const result = runWalkForward({
    sessions,
    trainSize: CONFIG.trainSize,
    testSize:  CONFIG.testSize,
    stepSize:  CONFIG.stepSize,
    strategy,
  });

  return { market, sessionsCount: sessions.length, result, error: null };
}

// ════════════════════════════════════════════════════════════════
// Output
// ════════════════════════════════════════════════════════════════

function formatResult(r: ReturnType<typeof runForMarket>): string {
  if (r.error) return `  [${r.market}] ❌ ${r.error}`;
  const wf = r.result!;
  const lines: string[] = [];
  lines.push(`  [${r.market}] ✅ 窗口數 ${wf.windows.length}`);
  lines.push(`         robustnessScore  = ${wf.robustnessScore.toFixed(1)}%  (測試窗勝率 > 50% 的比例)`);
  lines.push(`         efficiencyRatio  = ${wf.efficiencyRatio?.toFixed(3) ?? 'n/a'}  (test_avg / train_avg)`);
  const agg = wf.aggregateTestStats;
  if (agg) {
    lines.push(`         aggregate test:  trades=${agg.totalTrades}, winRate=${agg.winRate?.toFixed(1)}%, avgNet=${agg.avgNetReturn?.toFixed(2)}%`);
    lines.push(`                          maxDD=${agg.maxDrawdown?.toFixed(2)}%, sharpe=${agg.sharpeRatio?.toFixed(2)}, PF=${agg.profitFactor?.toFixed(2)}`);
  }
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════

function main(): void {
  const markets: Array<'TW' | 'CN'> = CONFIG.market ? [CONFIG.market] : ['TW', 'CN'];
  const all: Array<ReturnType<typeof runForMarket>> = [];

  for (const m of markets) {
    console.log(`\n── ${m} ──`);
    const r = runForMarket(m);
    console.log(formatResult(r));
    all.push(r);
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: CONFIG,
    perMarket: all.map(r => ({
      market: r.market,
      sessionsCount: r.sessionsCount,
      error: r.error,
      robustnessScore: r.result?.robustnessScore ?? null,
      efficiencyRatio: r.result?.efficiencyRatio ?? null,
      aggregateTestStats: r.result?.aggregateTestStats ?? null,
      windows: r.result?.windows.map(w => ({
        windowIndex: w.windowIndex,
        trainSessions: w.trainSessions,
        testSessions: w.testSessions,
        trainStats: w.trainStats,
        testStats: w.testStats,
      })) ?? [],
    })),
  }, null, 2));
  console.log(`\n  寫入 ${path.relative(process.cwd(), OUT_JSON)}\n`);
}

main();
