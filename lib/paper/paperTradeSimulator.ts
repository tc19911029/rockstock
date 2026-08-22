/**
 * Paper Trade Simulator — 核心邏輯（lib 層）
 *
 * 用 scan blob + L1 candles 模擬交易，產出累計淨值 + 勝率/PnL 統計。
 * 被 scripts/paper-trade-simulator.ts、scripts/paper-trade-sweep.ts、
 * app/api/cron/paper-portfolio-tick/route.ts 共用。
 *
 * 邏輯：
 * 1. 對每個交易日，從 scan-{market}-long-daily-{date}.json 載入候選
 * 2. 套 Tier 1 過濾（六條件分數 + 命中 A 級字母 + 成交額排名）
 * 3. 取前 signalsPerDay 檔
 * 4. 對每個訊號跑 BacktestEngine.runSingleBacktest 取得淨報酬
 * 5. B1 等權模型累計淨值（當日所有 picks 等權分配資金，賣了再買）
 */

import fs from 'fs';
import path from 'path';
import { runSingleBacktest, scanResultToSignal, DEFAULT_STRATEGY, type BacktestStrategyParams } from '@/lib/backtest/BacktestEngine';
import type { StockScanResult, ForwardCandle } from '@/lib/scanner/types';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

// ════════════════════════════════════════════════════════════════
// Types & config
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
  /**
   * 大盤過濾：true 時，前一日大盤指數（TW: 0050.TW、CN: 000300.SS）
   * 不滿足 close > MA20 且 MA5 > MA10 就 skip 當日所有訊號。
   * 任務 #10：CN audit 揭露 5/13 系統性大跌日 5 檔同步爆雷的根因。
   */
  skipNonBullishDays: boolean;
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
  skipNonBullishDays: true,
};

/**
 * 2026-05-22 sweep winning combo（baseline-kpi.md 第 11 節）
 * 在 22 天 TW 樣本上勝率 77.8% / 平均 +4.54% / 總 +43.63%
 * 注意：9 筆樣本太少、有 selection bias，需 ≥ 60 筆累積後重新驗證
 */
export const TW_PROD_CONFIG: SimConfig = {
  ...DEFAULT_SIM_CONFIG,
  market:          'TW',
  signalsPerDay:   1,
  topTurnoverRank: 50,
  holdDays:        5,
};

export interface DayResult {
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

// ════════════════════════════════════════════════════════════════
// Data root override（給 cron route 在 Vercel 上指向不同 path 用）
// ════════════════════════════════════════════════════════════════

let dataRoot = path.join(process.cwd(), 'data');

export function setDataRoot(p: string): void { dataRoot = p; }
export function getDataRoot(): string { return dataRoot; }

// ════════════════════════════════════════════════════════════════
// L1 candles + MA
// ════════════════════════════════════════════════════════════════

interface RawCandle { date: string; open: number; high: number; low: number; close: number; volume: number }
const candleCache = new Map<string, RawCandle[] | null>();

function loadCandles(market: 'TW' | 'CN', symbol: string): RawCandle[] | null {
  const key = `${market}|${symbol}`;
  if (candleCache.has(key)) return candleCache.get(key)!;
  const file = path.join(dataRoot, 'candles', market, `${symbol}.json`);
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

// ════════════════════════════════════════════════════════════════
// 大盤趨勢過濾（任務 #10）
// ════════════════════════════════════════════════════════════════

/**
 * 前一日大盤指數狀態：'bullish' = close > MA20 且 MA5 > MA10
 * 其他都 'non-bullish'（包含盤整 / 空頭）。
 *
 * 大盤指數來源：TW = 0050.TW（台灣 50 ETF），CN = 000300.SS（滬深 300）
 * fail-open：候 candle 缺漏時回 'bullish' 不過濾（避免過嚴打死所有訊號）
 */
function getMarketTrendAt(market: 'TW' | 'CN', date: string): 'bullish' | 'non-bullish' {
  const indexSymbol = market === 'TW' ? '0050.TW' : '000300.SS';
  const candles = loadCandles(market, indexSymbol);
  if (!candles || candles.length < 21) return 'bullish';
  const t = candles.findIndex(c => c.date === date);
  if (t < 1) return 'bullish';
  const prev = candles[t - 1];
  const ma5  = smaAt(candles, t - 1, 5);
  const ma10 = smaAt(candles, t - 1, 10);
  const ma20 = smaAt(candles, t - 1, 20);
  if (ma5 == null || ma10 == null || ma20 == null) return 'bullish';
  if (prev.close > ma20 && ma5 > ma10) return 'bullish';
  return 'non-bullish';
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
// Scan blob loader
// ════════════════════════════════════════════════════════════════

export function listDailyDates(market: 'TW' | 'CN'): string[] {
  const re = new RegExp(`^scan-${market}-long-daily-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
  try {
    return fs.readdirSync(dataRoot)
      .map(f => f.match(re))
      .filter((m): m is RegExpMatchArray => !!m)
      .map(m => m[1])
      .sort();
  } catch {
    return [];
  }
}

function loadScanResults(market: 'TW' | 'CN', date: string): StockScanResult[] {
  const file = path.join(dataRoot, `scan-${market}-long-daily-${date}.json`);
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (d.results ?? []) as StockScanResult[];
  } catch {
    return [];
  }
}

// ════════════════════════════════════════════════════════════════
// Tier 1 filter
// ════════════════════════════════════════════════════════════════

export function selectTier1(results: StockScanResult[], cfg: SimConfig): StockScanResult[] {
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

export function simulate(cfg: SimConfig = DEFAULT_SIM_CONFIG, opts: { verbose?: boolean } = {}): SimResult {
  const verbose = opts.verbose ?? false;
  const dates = listDailyDates(cfg.market);
  if (verbose) console.log(`  [${cfg.market}] daily session: ${dates.length} 天 (${dates[0]} ~ ${dates[dates.length - 1]})`);

  const strategy: BacktestStrategyParams = {
    ...DEFAULT_STRATEGY,
    holdDays: cfg.holdDays,
    stopLoss:    -0.07,
    takeProfit:   null,
    trailingStop: 0.03,
    trailingActivate: 0.05,
  };

  const days: DayResult[] = [];
  let equity = cfg.capital;
  const equityCurve: Array<{ date: string; equity: number }> = [];
  let totalSignals = 0, totalPicks = 0, totalWins = 0;
  let skippedByMarketFilter = 0;
  const allReturns: number[] = [];

  for (const date of dates) {
    // 任務 #10：大盤過濾 — 非多頭日 skip 所有訊號
    if (cfg.skipNonBullishDays) {
      const trend = getMarketTrendAt(cfg.market, date);
      if (trend === 'non-bullish') {
        skippedByMarketFilter++;
        days.push({ date, signals: 0, picks: 0, avgReturn: 0, picksDetail: [] });
        equityCurve.push({ date, equity: +equity.toFixed(0) });
        continue;
      }
    }

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

      const netPnL = trade.netReturn / 100;
      dayReturn += netPnL;
      dayPicks++;
      totalPicks++;
      if (netPnL > 0) totalWins++;
      allReturns.push(netPnL * 100);

      picksDetail.push({
        symbol: r.symbol,
        name: stockDisplayName(r.name, r.symbol),
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

    if (dayPicks > 0) equity *= (1 + avgDayReturn);
    equityCurve.push({ date, equity: +equity.toFixed(0) });
  }

  const winRate = totalPicks > 0 ? totalWins / totalPicks * 100 : 0;
  const avgReturn = allReturns.length > 0 ? allReturns.reduce((s, x) => s + x, 0) / allReturns.length : 0;
  const totalReturn = (equity - cfg.capital) / cfg.capital * 100;

  if (verbose && cfg.skipNonBullishDays) {
    console.log(`  [${cfg.market}] 大盤過濾 skipped ${skippedByMarketFilter} / ${dates.length} 天`);
  }

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
