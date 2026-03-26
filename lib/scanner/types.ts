export type MarketId = 'TW' | 'CN';

export interface TriggeredRule {
  ruleId: string;
  ruleName: string;
  signalType: 'BUY' | 'SELL' | 'WATCH' | 'ADD' | 'REDUCE';
  reason: string;
}

export interface SixConditionsBreakdown {
  trend: boolean;
  position: boolean;
  kbar: boolean;
  ma: boolean;
  volume: boolean;
  indicator: boolean;
}

export interface StockScanResult {
  symbol: string;
  name: string;
  market: MarketId;
  price: number;
  changePercent: number;
  volume: number;
  triggeredRules: TriggeredRule[];
  sixConditionsScore: number;   // 0–6
  sixConditionsBreakdown: SixConditionsBreakdown;
  trendState: '多頭' | '空頭' | '盤整';
  trendPosition: string;
  scanTime: string;             // ISO timestamp
}

export interface MarketConfig {
  marketId: MarketId;
  name: string;
  scanTimeLocal: string;  // e.g. '13:00'
  timezone: string;
}

export interface ScanSession {
  id: string;            // e.g. 'TW-2026-03-25'
  market: MarketId;
  date: string;          // YYYY-MM-DD
  scanTime: string;      // ISO timestamp when scan ran
  resultCount: number;
  results: StockScanResult[];
}

// ── Backtest types ─────────────────────────────────────────────────────────────

export interface ForwardCandle {
  date: string;
  open:  number;
  close: number;
  high:  number;
  low:   number;
}

export interface StockForwardPerformance {
  symbol: string;
  name: string;
  scanDate: string;
  scanPrice: number;
  openReturn: number | null;  // next trading day open vs scan close (proxy for "隔天開盤")
  d1Return:   number | null;  // % return after 1 trading day close
  d2Return:   number | null;
  d3Return:   number | null;
  d4Return:   number | null;
  d5Return:   number | null;
  d10Return:  number | null;
  d20Return:  number | null;
  maxGain:    number;         // max intra-window % gain (vs scanPrice)
  maxLoss:    number;         // max intra-window % loss (negative, vs scanPrice)
  forwardCandles: ForwardCandle[];
}

export interface BacktestSession {
  id: string;
  market: MarketId;
  scanDate: string;
  createdAt: string;
  scanResults: StockScanResult[];
  performance: StockForwardPerformance[];
  /** 嚴謹回測結果（v2+，含完整進出場紀錄） */
  trades?: import('@/lib/backtest/BacktestEngine').BacktestTrade[];
  stats?:  import('@/lib/backtest/BacktestEngine').BacktestStats;
  strategyVersion?: string;
}
