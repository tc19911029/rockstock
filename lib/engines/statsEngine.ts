import { Trade, PerformanceStats, AccountState, CandleWithIndicators } from '@/types';

/**
 * Compute performance statistics from trade history.
 * Call this whenever trades or current price changes.
 */
export function computeStats(
  state: AccountState,
  candles: CandleWithIndicators[],
  currentIndex: number
): PerformanceStats {
  const sellTrades = state.trades.filter((t) => t.action === 'SELL');
  const winTrades  = sellTrades.filter((t) => (t.realizedPnL ?? 0) > 0);
  const lossTrades = sellTrades.filter((t) => (t.realizedPnL ?? 0) <= 0);

  const totalRealizedPnL = sellTrades.reduce(
    (sum, t) => sum + (t.realizedPnL ?? 0),
    0
  );

  // Build equity curve: replay account value at each candle date
  // This is a simplified version — we track assets at each candle where a trade occurred
  const equityCurve = buildEquityCurve(state, candles, currentIndex);

  const totalAssets =
    state.cash +
    state.shares * (candles[currentIndex]?.close ?? 0);

  return {
    totalTrades: sellTrades.length,
    winCount: winTrades.length,
    lossCount: lossTrades.length,
    winRate: sellTrades.length > 0 ? winTrades.length / sellTrades.length : 0,
    totalRealizedPnL,
    totalReturnRate: (totalAssets - state.initialCapital) / state.initialCapital,
    equityCurve,
  };
}

/**
 * Build a simplified equity curve based on trade events.
 * In a full implementation, this would track assets at every candle.
 */
function buildEquityCurve(
  state: AccountState,
  candles: CandleWithIndicators[],
  currentIndex: number
): { date: string; totalAssets: number }[] {
  if (state.trades.length === 0) return [];

  const curve: { date: string; totalAssets: number }[] = [];

  // Start point
  curve.push({ date: candles[0]?.date ?? '', totalAssets: state.initialCapital });

  // Add a point at each trade date
  // (Simplified: just shows trade events, not continuous curve)
  let runningCash = state.initialCapital;
  let runningShares = 0;
  let runningAvgCost = 0;

  for (const trade of state.trades) {
    const candleAtTrade = candles.find((c) => c.date === trade.date);
    const price = candleAtTrade?.close ?? trade.price;

    if (trade.action === 'BUY') {
      runningCash -= trade.amount + trade.fee;
      const totalCost = runningShares * runningAvgCost + trade.amount;
      runningShares += trade.shares;
      runningAvgCost = runningShares > 0 ? totalCost / runningShares : 0;
    } else {
      runningCash += trade.amount - trade.fee;
      runningShares -= trade.shares;
      if (runningShares === 0) runningAvgCost = 0;
    }

    const totalAssets = runningCash + runningShares * price;
    curve.push({ date: trade.date, totalAssets: +totalAssets.toFixed(2) });
  }

  // Current position
  const currentPrice = candles[currentIndex]?.close ?? 0;
  const currentAssets = state.cash + state.shares * currentPrice;
  curve.push({
    date: candles[currentIndex]?.date ?? '',
    totalAssets: +currentAssets.toFixed(2),
  });

  return curve;
}

/**
 * Format a number as currency with commas (e.g. 1,234,567)
 */
export function formatCurrency(n: number): string {
  return Math.round(n).toLocaleString('zh-TW');
}

/**
 * Format a return rate as percentage with sign (e.g. +12.34%)
 */
export function formatReturn(rate: number): string {
  const sign = rate >= 0 ? '+' : '';
  return `${sign}${(rate * 100).toFixed(2)}%`;
}
