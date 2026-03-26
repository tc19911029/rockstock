/**
 * BacktestEngine.ts — 嚴謹回測引擎
 *
 * 核心設計原則：
 * 1. 無未來函數：訊號日的資料不能包含訊號日之後的資訊
 * 2. 進場使用隔日開盤價（最接近實際操作）
 * 3. 出場規則明確：固定持有N日、停利、停損
 * 4. 每筆交易都保留完整紀錄（可追溯原因）
 * 5. 成本模型分市場計算（台股/陸股分開）
 */

import { ForwardCandle, MarketId, StockScanResult } from '@/lib/scanner/types';
import { calcRoundTripCost, CostParams } from './CostModel';

// ── Types ───────────────────────────────────────────────────────────────────────

/** 回測進場方式 */
export type EntryType = 'nextOpen' | 'nextClose';

/** 出場規則 */
export type ExitRule =
  | { type: 'holdDays';   days: number }
  | { type: 'stopLoss';   pct: number }   // 負數，e.g. -0.07 = -7%
  | { type: 'takeProfit'; pct: number };  // 正數，e.g. 0.15 = +15%

/** 策略參數 */
export interface BacktestStrategyParams {
  entryType:  EntryType;
  holdDays:   number;       // 固定持有天數（主要出場規則）
  stopLoss:   number | null; // 停損比例（負數，null = 不設停損）
  takeProfit: number | null; // 停利比例（正數，null = 不設停利）
  costParams: CostParams;
}

/** 每筆回測交易完整紀錄 */
export interface BacktestTrade {
  // ── 股票資訊 ──
  symbol:  string;
  name:    string;
  market:  MarketId;

  // ── 訊號資訊 ──
  signalDate:    string;    // 掃描日期（發現訊號的日期）
  signalScore:   number;    // 六大條件分數 0-6
  signalReasons: string[];  // 哪些條件通過（說明命中原因）
  trendState:    string;    // 訊號當時的趨勢狀態
  trendPosition: string;    // 訊號當時的位置

  // ── 進場 ──
  entryDate:  string;       // 實際進場日期
  entryPrice: number;       // 進場價
  entryType:  EntryType;    // 進場方式

  // ── 出場 ──
  exitDate:   string;       // 出場日期
  exitPrice:  number;       // 出場價
  exitReason: string;       // 出場原因（'holdDays' | 'stopLoss' | 'takeProfit' | 'dataEnd'）
  holdDays:   number;       // 實際持有天數（交易日）

  // ── 績效 ──
  grossReturn: number;      // 毛報酬率 % (不含成本)
  netReturn:   number;      // 淨報酬率 % (含成本)
  buyFee:      number;      // 買入成本（元）
  sellFee:     number;      // 賣出成本（元）
  totalCost:   number;      // 總成本（元）
}

/** 回測統計摘要 */
export interface BacktestStats {
  count:       number;
  wins:        number;
  losses:      number;
  winRate:     number;   // %
  avgGrossReturn: number;
  avgNetReturn:   number;
  medianReturn:   number;
  maxGain:     number;
  maxLoss:     number;
  maxDrawdown: number;  // 最大連虧（以淨報酬計）
  totalNetReturn: number; // 所有筆的淨報酬加總（非複利）
  expectancy:  number;  // 期望值 = winRate * avgWin - lossRate * avgLoss
}

// ── Default Params ──────────────────────────────────────────────────────────────

export const DEFAULT_STRATEGY: BacktestStrategyParams = {
  entryType:  'nextOpen',
  holdDays:   5,
  stopLoss:   -0.07,     // -7% 停損（朱老師標準）
  takeProfit: null,      // 不設強制停利，讓它跑滿 holdDays
  costParams: { twFeeDiscount: 1.0 },
};

// ── Engine ──────────────────────────────────────────────────────────────────────

/**
 * 對單一掃描結果計算回測績效
 *
 * @param scanResult  掃描器輸出的股票結果
 * @param forwardCandles 訊號日之後的K線（已排除訊號日當天）
 * @param strategy    策略參數
 */
export function runSingleBacktest(
  scanResult:     StockScanResult,
  forwardCandles: ForwardCandle[],
  strategy:       BacktestStrategyParams = DEFAULT_STRATEGY,
): BacktestTrade | null {
  if (forwardCandles.length === 0) return null;

  // ── 進場 ──────────────────────────────────────────────────────────────────
  // 隔日開盤進場（nextOpen）或隔日收盤（nextClose）
  const entryCandle = forwardCandles[0];
  const entryPrice = strategy.entryType === 'nextOpen'
    ? entryCandle.open
    : entryCandle.close;

  if (!entryPrice || entryPrice <= 0) return null;

  // ── 出場模擬（逐根判斷停損/停利） ─────────────────────────────────────────
  let exitDate:   string = '';
  let exitPrice:  number = 0;
  let exitReason: string = 'holdDays';
  let holdDays:   number = 0;

  // 持有期間：從 d0（進場當天/隔日）到 holdDays-1
  const holdWindow = forwardCandles.slice(
    strategy.entryType === 'nextOpen' ? 0 : 1,
    (strategy.entryType === 'nextOpen' ? 0 : 1) + strategy.holdDays,
  );

  for (let i = 0; i < holdWindow.length; i++) {
    const c = holdWindow[i];
    holdDays = i + 1;

    const lowRet  = (c.low  - entryPrice) / entryPrice;
    const highRet = (c.high - entryPrice) / entryPrice;

    // 先檢查停損（日內最低觸碰）
    if (strategy.stopLoss !== null && lowRet <= strategy.stopLoss) {
      // 假設以停損價出場（簡化：使用停損比例計算出場價）
      exitPrice  = +(entryPrice * (1 + strategy.stopLoss)).toFixed(3);
      exitDate   = c.date;
      exitReason = 'stopLoss';
      break;
    }

    // 再檢查停利（日內最高觸碰）
    if (strategy.takeProfit !== null && highRet >= strategy.takeProfit) {
      exitPrice  = +(entryPrice * (1 + strategy.takeProfit)).toFixed(3);
      exitDate   = c.date;
      exitReason = 'takeProfit';
      break;
    }

    // 最後一天：以收盤出場
    if (i === holdWindow.length - 1) {
      exitPrice  = c.close;
      exitDate   = c.date;
      exitReason = holdWindow.length < strategy.holdDays ? 'dataEnd' : 'holdDays';
    }
  }

  if (!exitDate || exitPrice <= 0 || holdDays === 0) return null;

  // ── 成本計算 ──────────────────────────────────────────────────────────────
  // 假設 1 張（1000 股）台股 / 100 股陸股 的標準單位計算成本比例
  const unitShares  = scanResult.market === 'TW' ? 1000 : 100;
  const buyAmount   = entryPrice * unitShares;
  const sellAmount  = exitPrice  * unitShares;

  const cost = calcRoundTripCost(
    scanResult.market,
    scanResult.symbol,
    buyAmount,
    sellAmount,
    strategy.costParams,
  );

  // ── 報酬計算 ──────────────────────────────────────────────────────────────
  const grossReturn = +((exitPrice - entryPrice) / entryPrice * 100).toFixed(3);
  const netPnL      = sellAmount - buyAmount - cost.total;
  const netReturn   = +(netPnL / buyAmount * 100).toFixed(3);

  // ── 命中原因（從六大條件拼出） ─────────────────────────────────────────────
  const { sixConditionsBreakdown, sixConditionsScore, trendState, trendPosition } = scanResult;
  const reasons: string[] = [];
  if (sixConditionsBreakdown.trend)     reasons.push('趨勢多頭');
  if (sixConditionsBreakdown.position)  reasons.push('位置良好');
  if (sixConditionsBreakdown.kbar)      reasons.push('K棒長紅');
  if (sixConditionsBreakdown.ma)        reasons.push('均線多排');
  if (sixConditionsBreakdown.volume)    reasons.push('量能放大');
  if (sixConditionsBreakdown.indicator) reasons.push('指標配合');

  return {
    symbol:  scanResult.symbol,
    name:    scanResult.name,
    market:  scanResult.market,

    signalDate:    scanResult.scanTime.split('T')[0],
    signalScore:   sixConditionsScore,
    signalReasons: reasons,
    trendState:    trendState,
    trendPosition: trendPosition,

    entryDate:  entryCandle.date,
    entryPrice: +entryPrice.toFixed(3),
    entryType:  strategy.entryType,

    exitDate,
    exitPrice:  +exitPrice.toFixed(3),
    exitReason,
    holdDays,

    grossReturn,
    netReturn,
    buyFee:    cost.buyFee,
    sellFee:   cost.sellFee,
    totalCost: cost.total,
  };
}

/**
 * 批量回測：對所有掃描結果計算回測績效
 */
export function runBatchBacktest(
  scanResults:          StockScanResult[],
  forwardCandlesMap:    Record<string, ForwardCandle[]>,
  strategy:             BacktestStrategyParams = DEFAULT_STRATEGY,
): BacktestTrade[] {
  const trades: BacktestTrade[] = [];

  for (const result of scanResults) {
    const candles = forwardCandlesMap[result.symbol] ?? [];
    const trade   = runSingleBacktest(result, candles, strategy);
    if (trade) trades.push(trade);
  }

  return trades;
}

/**
 * 計算回測統計摘要
 */
export function calcBacktestStats(trades: BacktestTrade[]): BacktestStats | null {
  if (trades.length === 0) return null;

  const returns = trades.map(t => t.netReturn);
  const wins    = trades.filter(t => t.netReturn > 0);
  const losses  = trades.filter(t => t.netReturn <= 0);

  const avgGrossReturn  = +(trades.reduce((s, t) => s + t.grossReturn, 0) / trades.length).toFixed(3);
  const avgNetReturn    = +(returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(3);

  const sorted          = [...returns].sort((a, b) => a - b);
  const medianReturn    = +sorted[Math.floor(sorted.length / 2)].toFixed(3);
  const maxGain         = +Math.max(...returns).toFixed(3);
  const maxLoss         = +Math.min(...returns).toFixed(3);
  const totalNetReturn  = +returns.reduce((a, b) => a + b, 0).toFixed(3);

  // 最大連虧（consecutive losses 的累積）
  let maxDrawdown = 0;
  let curDrawdown = 0;
  for (const r of returns) {
    if (r < 0) { curDrawdown += r; maxDrawdown = Math.min(maxDrawdown, curDrawdown); }
    else { curDrawdown = 0; }
  }

  const avgWin  = wins.length   > 0 ? wins.reduce((s, t) => s + t.netReturn, 0)   / wins.length   : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netReturn, 0) / losses.length : 0;
  const winRate = wins.length / trades.length;
  const expectancy = +(winRate * avgWin + (1 - winRate) * avgLoss).toFixed(3);

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
  };
}

/**
 * 依持有天數分組統計（用於比較 d1/d3/d5/d10/d20 的差異）
 */
export function calcStatsByHorizon(
  scanResults:       StockScanResult[],
  forwardCandlesMap: Record<string, ForwardCandle[]>,
  horizons:          number[] = [1, 3, 5, 10, 20],
  baseStrategy:      BacktestStrategyParams = DEFAULT_STRATEGY,
): Record<number, BacktestStats | null> {
  const result: Record<number, BacktestStats | null> = {};

  for (const days of horizons) {
    const strategy = { ...baseStrategy, holdDays: days, stopLoss: null, takeProfit: null };
    const trades   = runBatchBacktest(scanResults, forwardCandlesMap, strategy);
    result[days]   = calcBacktestStats(trades);
  }

  return result;
}
