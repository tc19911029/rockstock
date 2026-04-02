/**
 * Backtest statistics calculation — separated from BacktestEngine
 * for reuse across different backtest modes.
 *
 * Extracted from BacktestEngine.ts for modularity.
 */

import { ForwardCandle, StockScanResult } from '@/lib/scanner/types';
import type { BacktestTrade, BacktestStats, SkipReasons, BacktestStrategyParams } from './BacktestEngine';
import { runBatchBacktest, DEFAULT_STRATEGY } from './BacktestEngine';

/**
 * Calculate comprehensive backtest statistics from a list of trades.
 * Includes: win rate, Sharpe ratio, profit factor, max drawdown, etc.
 */
export function calcBacktestStats(
  trades:       BacktestTrade[],
  skippedCount = 0,
  skipReasons?: SkipReasons,
): BacktestStats | null {
  if (trades.length === 0) return null;

  const returns = trades.map(t => t.netReturn);
  const wins    = trades.filter(t => t.netReturn > 0);
  const losses  = trades.filter(t => t.netReturn <= 0);

  const avgGrossReturn = +(trades.reduce((s, t) => s + t.grossReturn, 0) / trades.length).toFixed(3);
  const avgNetReturn   = +(returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(3);

  const sorted       = [...returns].sort((a, b) => a - b);
  const medianReturn = +sorted[Math.floor(sorted.length / 2)].toFixed(3);
  const maxGain      = +Math.max(...returns).toFixed(3);
  const maxLoss      = +Math.min(...returns).toFixed(3);
  const totalNetReturn = +returns.reduce((a, b) => a + b, 0).toFixed(3);

  // Maximum Drawdown: equity curve peak to trough
  let equity      = 0;
  let peak        = 0;
  let maxDrawdown = 0;
  for (const r of returns) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = equity - peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  const avgWin  = wins.length   > 0 ? wins.reduce((s, t)   => s + t.netReturn, 0) / wins.length   : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netReturn, 0) / losses.length : 0;
  const winRate = wins.length / trades.length;
  const expectancy = +(winRate * avgWin + (1 - winRate) * avgLoss).toFixed(3);

  // Risk-adjusted metrics
  let sharpeRatio:  number | null = null;
  let profitFactor: number | null = null;
  let payoffRatio:  number | null = null;

  if (trades.length >= 2) {
    const variance = returns.reduce((s, r) => s + (r - avgNetReturn) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    sharpeRatio = std > 0 ? +(avgNetReturn / std).toFixed(3) : null;

    const totalWin  = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
    const totalLossAbs = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
    profitFactor = totalLossAbs > 0 ? +(totalWin / totalLossAbs).toFixed(3) : null;

    const avgLossAbs = avgLoss < 0 ? Math.abs(avgLoss) : 0;
    payoffRatio = avgLossAbs > 0 ? +(avgWin / avgLossAbs).toFixed(3) : null;
  }

  // Survival bias stats
  const total = trades.length + skippedCount;
  const coverageRate = total > 0 ? +(trades.length / total * 100).toFixed(1) : 100;

  return {
    count:    trades.length,
    wins:     wins.length,
    losses:   losses.length,
    winRate:  +(winRate * 100).toFixed(1),
    avgGrossReturn,
    avgNetReturn,
    medianReturn,
    maxGain,
    maxLoss,
    maxDrawdown: +maxDrawdown.toFixed(3),
    totalNetReturn,
    expectancy,
    sharpeRatio,
    profitFactor,
    payoffRatio,
    skippedCount,
    coverageRate,
    skipReasons,
    gapUpCount: trades.filter(t => t.isGapUp).length,
    winRateByRegime: (() => {
      function regimeStats(regime: string) {
        const group = trades.filter(t => t.trendState === regime);
        if (group.length === 0) return null;
        const w = group.filter(t => t.netReturn > 0).length;
        return { count: group.length, winRate: +(w / group.length * 100).toFixed(1) };
      }
      return { bull: regimeStats('多頭'), sideways: regimeStats('盤整'), bear: regimeStats('空頭') };
    })(),
  };
}

/**
 * Calculate stats grouped by holding period horizon.
 * Useful for comparing d1/d3/d5/d10/d20 performance.
 */
export function calcStatsByHorizon(
  scanResults:       StockScanResult[],
  forwardCandlesMap: Record<string, ForwardCandle[]>,
  horizons:          number[] = [1, 3, 5, 10, 20],
  baseStrategy:      BacktestStrategyParams = DEFAULT_STRATEGY,
): Record<number, BacktestStats | null> {
  const result: Record<number, BacktestStats | null> = {};

  for (const days of horizons) {
    const strat = { ...baseStrategy, holdDays: days, stopLoss: null, takeProfit: null };
    const { trades, skippedCount } = runBatchBacktest(scanResults, forwardCandlesMap, strat);
    result[days] = calcBacktestStats(trades, skippedCount);
  }

  return result;
}
