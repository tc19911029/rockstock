/**
 * Phase 3 MVP: Paper Trade Simulator
 *
 * 對「過去 N 個交易日」的 scan blob 跑模擬交易，產出累計淨值曲線 + 勝率/PnL 統計。
 *
 * 邏輯：
 * 1. 對每個交易日，從 scan-{market}-long-daily-{date}.json 載入候選
 * 2. 套 Tier 1 過濾：六條件 ≥ 5 + 命中 A 級策略字母 + 成交額排名 top 50
 * 3. 取前 SIGNALS_PER_DAY 檔（依成交額排名）
 * 4. 對每個訊號從 L1 candles 取 forward candles，跑 BacktestEngine.runSingleBacktest
 * 5. 累計 PnL（B1 模型：每日 all-in 等權分配，賣了再買）
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/paper-trade-simulator.ts
 *
 * 環境變數：
 *   MARKET=TW|CN          只跑單一市場（預設 TW）
 *   SIGNALS_PER_DAY=3     每日進場檔數（預設 3）
 *   HOLD_DAYS=10          持有天數（預設 10，對應 baseline d10 A 級組合）
 *   CAPITAL=1000000       初始資金（預設 100 萬）
 *
 * 輸出：
 *   data/paper-portfolio/simulator-{market}-{today}.json
 *   data/paper-portfolio/simulator-{market}-{today}.md
 */

import fs from 'fs';
import path from 'path';
import { runSingleBacktest, scanResultToSignal, DEFAULT_STRATEGY, type BacktestStrategyParams } from '@/lib/backtest/BacktestEngine';
import type { StockScanResult, ForwardCandle } from '@/lib/scanner/types';

// ════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════

export interface SimConfig {
  market:           'TW' | 'CN';
  signalsPerDay:    number;
  holdDays:         number;
  capital:          number;
  forwardDays:      number;
  aLevelMethods:    Set<string>;
  minSixCondScore:  number;
  topTurnoverRank:  number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  market:          'TW',
  signalsPerDay:   3,
  holdDays:        10,
  capital:         1_000_000,
  forwardDays:     30,
  aLevelMethods:   new Set(['B', 'M', 'N', 'P', 'Q', 'O']),
  minSixCondScore: 5,
  topTurnoverRank: 50,
};

function configFromEnv(): SimConfig {
  return {
    ...DEFAULT_SIM_CONFIG,
    market:          (process.env.MARKET ?? DEFAULT_SIM_CONFIG.market) as 'TW' | 'CN',
    signalsPerDay:   Number(process.env.SIGNALS_PER_DAY  ?? DEFAULT_SIM_CONFIG.signalsPerDay),
    holdDays:        Number(process.env.HOLD_DAYS        ?? DEFAULT_SIM_CONFIG.holdDays),
    capital:         Number(process.env.CAPITAL          ?? DEFAULT_SIM_CONFIG.capital),
    forwardDays:     Number(process.env.FORWARD_DAYS     ?? DEFAULT_SIM_CONFIG.forwardDays),
    topTurnoverRank: Number(process.env.TOP_TURNOVER_RANK ?? DEFAULT_SIM_CONFIG.topTurnoverRank),
  };
}

const ROOT = path.join(process.cwd(), 'data');
const CANDLE_ROOT = path.join(ROOT, 'candles');
const OUT_DIR = path.join(ROOT, 'paper-portfolio');

// ════════════════════════════════════════════════════════════════
// Helpers (reuse loaders from backtest-walk-forward.ts pattern)
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

function buildForwardCandles(market: 'TW' | 'CN', symbol: string, signalDate: string, forwardDays: number): ForwardCandle[] {
  const candles = loadCandles(market, symbol);
  if (!candles) return [];
  const t0 = candles.findIndex(c => c.date === signalDate);
  if (t0 < 0) return [];
  const out: ForwardCandle[] = [];
  for (let i = t0 + 1; i <= Math.min(t0 + forwardDays, candles.length - 1); i++) {
    const c = candles[i];
    out.push({
      date: c.date,
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      ma5:  smaAt(candles, i, 5),
      ma10: smaAt(candles, i, 10),
      ma20: smaAt(candles, i, 20),
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// Load scan results
// ════════════════════════════════════════════════════════════════

function listDailyDates(market: 'TW' | 'CN'): string[] {
  const re = new RegExp(`^scan-${market}-long-daily-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
  return fs.readdirSync(ROOT)
    .map(f => f.match(re))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => m[1])
    .sort();
}

function loadScanResults(market: 'TW' | 'CN', date: string): StockScanResult[] {
  const file = path.join(ROOT, `scan-${market}-long-daily-${date}.json`);
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (d.results ?? []) as StockScanResult[];
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════════════════
// Tier 1 filter + signal selection
// ════════════════════════════════════════════════════════════════

function selectTier1(results: StockScanResult[], cfg: SimConfig): StockScanResult[] {
  return results.filter(r => {
    if ((r.sixConditionsScore ?? 0) < cfg.minSixCondScore) return false;
    const matched = r.matchedMethods ?? [];
    if (!matched.some(m => cfg.aLevelMethods.has(m))) return false;
    if (r.turnoverRank == null || r.turnoverRank > cfg.topTurnoverRank) return false;
    return true;
  })
  .sort((a, b) => (a.turnoverRank ?? 999) - (b.turnoverRank ?? 999))
  .slice(0, cfg.signalsPerDay);
}

// ════════════════════════════════════════════════════════════════
// Simulate
// ════════════════════════════════════════════════════════════════

interface DayResult {
  date: string;
  signals: number;          // 該日 Tier 1 訊號數
  picks: number;            // 實際進場數（扣掉漲停鎖死等）
  avgReturn: number;        // 該日平均淨報酬 (%)
  picksDetail: Array<{
    symbol: string; name: string; entryPrice: number; exitPrice: number;
    netReturnPct: number;   // 扣手續費後 (%)
    exitReason: string;
    holdDays: number;
  }>;
}

export interface SimResult {
  market: 'TW' | 'CN';
  config: SimConfig;
  days: DayResult[];
  totalSignals: number;
  totalPicks: number;
  totalWins: number;
  winRate: number;
  avgReturn: number;
  equityCurve: Array<{ date: string; equity: number }>;
  finalEquity: number;
  totalReturn: number;
}

export function simulate(cfg: SimConfig = DEFAULT_SIM_CONFIG, opts: { verbose?: boolean } = {}): SimResult {
  const verbose = opts.verbose ?? true;
  const dates = listDailyDates(cfg.market);
  if (verbose) console.log(`  [${cfg.market}] daily session: ${dates.length} 天 (${dates[0]} ~ ${dates[dates.length - 1]})`);

  const strategy: BacktestStrategyParams = {
    ...DEFAULT_STRATEGY,
    holdDays: cfg.holdDays,
    stopLoss:    -0.07,     // 書本 7% 停損
    takeProfit:   null,     // 無固定停利（靠 holdDays 出場 + 移動停利）
    trailingStop: 0.03,
    trailingActivate: 0.05,
  };

  const days: DayResult[] = [];
  let equity = cfg.capital;
  const equityCurve: Array<{ date: string; equity: number }> = [];
  let totalSignals = 0, totalPicks = 0, totalWins = 0;
  const allReturns: number[] = [];

  for (const date of dates) {
    const results = loadScanResults(cfg.market, date);
    const tier1 = selectTier1(results, cfg);
    totalSignals += tier1.length;

    const picksDetail: DayResult['picksDetail'] = [];
    let dayReturn = 0;
    let dayPicks = 0;

    for (const r of tier1) {
      const forwardCandles = buildForwardCandles(cfg.market, r.symbol, date, cfg.forwardDays);
      if (forwardCandles.length < 2) continue;
      const signal = scanResultToSignal(r);
      const trade = runSingleBacktest(signal, forwardCandles, strategy);
      if (!trade) continue;

      const netPnL = trade.netReturn / 100;  // BacktestTrade.netReturn 已含成本，單位 %
      dayReturn += netPnL;
      dayPicks++;
      totalPicks++;
      if (netPnL > 0) totalWins++;
      allReturns.push(netPnL * 100);

      picksDetail.push({
        symbol: r.symbol,
        name: r.name,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        netReturnPct: +(netPnL * 100).toFixed(2),
        exitReason: trade.exitReason,
        holdDays: trade.holdDays,
      });
    }

    const avgDayReturn = dayPicks > 0 ? dayReturn / dayPicks : 0;
    days.push({
      date,
      signals: tier1.length,
      picks: dayPicks,
      avgReturn: +(avgDayReturn * 100).toFixed(2),
      picksDetail,
    });

    // B1 等權模型：當日所有 picks 共用全資金（等權）
    if (dayPicks > 0) {
      equity *= (1 + avgDayReturn);
    }
    equityCurve.push({ date, equity: +equity.toFixed(0) });
  }

  const winRate = totalPicks > 0 ? totalWins / totalPicks * 100 : 0;
  const avgReturn = allReturns.length > 0 ? allReturns.reduce((s, x) => s + x, 0) / allReturns.length : 0;
  const totalReturn = (equity - cfg.capital) / cfg.capital * 100;

  return {
    market: cfg.market,
    config: cfg,
    days, totalSignals, totalPicks, totalWins,
    winRate: +winRate.toFixed(1),
    avgReturn: +avgReturn.toFixed(2),
    equityCurve,
    finalEquity: +equity.toFixed(0),
    totalReturn: +totalReturn.toFixed(2),
  };
}

// ════════════════════════════════════════════════════════════════
// Output
// ════════════════════════════════════════════════════════════════

function writeReport(r: SimResult): void {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(OUT_DIR, `simulator-${r.market}-${today}.json`);
  const mdPath = path.join(OUT_DIR, `simulator-${r.market}-${today}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(r, null, 2));

  const lines: string[] = [];
  lines.push(`# Paper Trade Simulator — ${r.market}`);
  lines.push('');
  lines.push(`產出時間：${new Date().toISOString()}`);
  lines.push(`期間：${r.days[0]?.date ?? '-'} ~ ${r.days[r.days.length - 1]?.date ?? '-'}（${r.days.length} 個交易日）`);
  lines.push('');
  lines.push(`## 過濾條件`);
  lines.push(`- 六條件分數 ≥ ${r.config.minSixCondScore}`);
  lines.push(`- 命中 A 級策略字母（${[...r.config.aLevelMethods].join('/')}）`);
  lines.push(`- 成交額排名 top ${r.config.topTurnoverRank}`);
  lines.push(`- 每日進場 ${r.config.signalsPerDay} 檔（依成交額排名）`);
  lines.push(`- 持有 ${r.config.holdDays} 天 + 移動停利 (3% 回撤，5% 啟動) + 停損 -7%`);
  lines.push('');
  lines.push(`## 統計`);
  lines.push(`| 項目 | 數值 |`);
  lines.push(`|---|---:|`);
  lines.push(`| 總 Tier 1 訊號數 | ${r.totalSignals} |`);
  lines.push(`| 實際進場數 | ${r.totalPicks} |`);
  lines.push(`| 勝場 | ${r.totalWins} |`);
  lines.push(`| 勝率 | ${r.winRate}% |`);
  lines.push(`| 平均單筆淨報酬 | ${r.avgReturn}% |`);
  lines.push(`| 初始資金 | $${r.config.capital.toLocaleString()} |`);
  lines.push(`| 最終資金 | $${r.finalEquity.toLocaleString()} |`);
  lines.push(`| 期間總報酬 | **${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}%** |`);
  lines.push('');
  lines.push(`## 每日明細（後 20 天）`);
  lines.push(`| 日期 | 訊號數 | 進場 | 日均報酬 | 累計資金 |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  const showDays = r.days.slice(-20);
  const equityMap = new Map(r.equityCurve.map(e => [e.date, e.equity]));
  for (const d of showDays) {
    lines.push(`| ${d.date} | ${d.signals} | ${d.picks} | ${d.avgReturn >= 0 ? '+' : ''}${d.avgReturn}% | $${(equityMap.get(d.date) ?? 0).toLocaleString()} |`);
  }
  lines.push('');
  lines.push(`## 全部進場明細（後 30 筆）`);
  lines.push(`| 日期 | 標的 | 進場 | 出場 | 淨報酬 | 持有 | 出場原因 |`);
  lines.push(`|---|---|---:|---:|---:|---:|---|`);
  const allPicks: Array<{ date: string } & DayResult['picksDetail'][number]> = [];
  for (const d of r.days) for (const p of d.picksDetail) allPicks.push({ date: d.date, ...p });
  const showPicks = allPicks.slice(-30);
  for (const p of showPicks) {
    lines.push(`| ${p.date} | ${p.symbol} ${p.name} | ${p.entryPrice} | ${p.exitPrice} | ${p.netReturnPct >= 0 ? '+' : ''}${p.netReturnPct}% | ${p.holdDays}d | ${p.exitReason} |`);
  }
  lines.push('');
  fs.writeFileSync(mdPath, lines.join('\n'));
  console.log(`  寫入 ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`  寫入 ${path.relative(process.cwd(), mdPath)}`);
}

function main(): void {
  const cfg = configFromEnv();
  console.log('\n── Paper Trade Simulator ──');
  const r = simulate(cfg);

  console.log('');
  console.log(`  總訊號數：${r.totalSignals}`);
  console.log(`  進場數：  ${r.totalPicks}`);
  console.log(`  勝率：    ${r.winRate}%`);
  console.log(`  平均單筆：${r.avgReturn}%`);
  console.log(`  初始：    $${cfg.capital.toLocaleString()}`);
  console.log(`  最終：    $${r.finalEquity.toLocaleString()}`);
  console.log(`  總報酬：  ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}%`);

  writeReport(r);
  console.log('');
}

// 只在被當 script 直接執行時跑 main；被 import 時跳過
const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('paper-trade-simulator.ts') || invokedPath.endsWith('paper-trade-simulator.js')) {
  main();
}
