// ============================================================
// Core type definitions for the Stock Replay Trainer
// ============================================================

/** Raw OHLCV candle data */
export interface Candle {
  date: string;       // ISO date string e.g. "2023-01-05"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Candle with computed technical indicators */
export interface CandleWithIndicators extends Candle {
  // Moving Averages
  ma5?: number;
  ma10?: number;
  ma20?: number;
  ma60?: number;
  /** Average volume over last 5 bars */
  avgVol5?: number;

  // MACD (params: fast=10, slow=20, signal=10 — 書中推薦參數)
  macdDIF?: number;   // fast EMA - slow EMA
  macdSignal?: number; // signal line (EMA of DIF)
  macdOSC?: number;   // histogram (DIF - signal), positive=red bar, negative=green bar

  // KD Stochastic (params: period=9, k=3, d=3)
  kdK?: number;       // K value (0–100)
  kdD?: number;       // D value (0–100)
}

/** Stock info returned from API */
export interface StockInfo {
  ticker: string;
  name: string;
}

/** A triggered rule signal */
export interface RuleSignal {
  type: 'BUY' | 'ADD' | 'REDUCE' | 'SELL' | 'WATCH';
  label: string;         // Short display label e.g. "可能買點"
  description: string;   // What happened (technical fact)
  reason: string;        // Why this matters + what to consider doing (book logic)
  ruleId: string;        // Which rule triggered this
}

/** A single trade record */
export interface Trade {
  id: string;
  date: string;
  action: 'BUY' | 'SELL';
  price: number;
  shares: number;
  amount: number;        // price * shares
  fee: number;           // transaction fee
  realizedPnL?: number;  // only for SELL trades
}

/** Account state at current replay position */
export interface AccountState {
  initialCapital: number;
  cash: number;
  shares: number;        // current holding shares
  avgCost: number;       // average cost per share
  realizedPnL: number;   // total realized P&L
  trades: Trade[];
}

/** Computed account metrics (derived from AccountState + current price) */
export interface AccountMetrics {
  cash: number;
  shares: number;
  avgCost: number;
  holdingValue: number;       // shares * currentPrice
  unrealizedPnL: number;      // holdingValue - shares * avgCost
  realizedPnL: number;
  totalAssets: number;        // cash + holdingValue
  returnRate: number;         // (totalAssets - initialCapital) / initialCapital
}

/** Performance statistics */
export interface PerformanceStats {
  totalTrades: number;        // total SELL trades
  winCount: number;
  lossCount: number;
  winRate: number;            // winCount / totalTrades
  totalRealizedPnL: number;
  totalReturnRate: number;
  equityCurve: { date: string; totalAssets: number }[];
}

/** Rule definition — implement this interface to add new rules */
export interface TradingRule {
  id: string;
  name: string;
  description: string;
  /** Returns a signal if the rule is triggered, otherwise null */
  evaluate(
    candles: CandleWithIndicators[],
    currentIndex: number
  ): RuleSignal | null;
}

/** A signal marker to draw on the candlestick chart */
export interface ChartSignalMarker {
  date: string;
  type: RuleSignal['type'];
  label: string;
}

/** Replay engine state */
export interface ReplayState {
  allCandles: CandleWithIndicators[];
  currentIndex: number;       // index of the last visible candle
  isPlaying: boolean;
  playSpeed: number;          // ms per candle during auto-play
}
