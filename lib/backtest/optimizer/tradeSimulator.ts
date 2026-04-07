/**
 * Trade Simulator — 橋接 DailyCandidate 與 runSOPBacktest()
 *
 * 將候選股的 candle 陣列轉換為 ForwardCandle[]，
 * 呼叫朱家泓 SOP 獲利方程式進行出場模擬。
 */

import {
  runSOPBacktest,
  DEFAULT_ZHU_EXIT,
  ZHU_PROFIT_FORMULA_STRATEGY,
} from '../BacktestEngine';
import type { TradeSignal, BacktestStrategyParams, ZhuExitParams } from '../BacktestEngine';
import type { ForwardCandle, MarketId } from '@/lib/scanner/types';
import type { CandleWithIndicators } from '@/types';
import type { TradeResult } from './types';

/** SOP 回測用策略參數：收盤前進場，出場交給獲利方程式 */
const SOP_STRATEGY_TW: BacktestStrategyParams = {
  ...ZHU_PROFIT_FORMULA_STRATEGY,
  entryType:   'nextClose',
  slippagePct: 0,
  holdDays:    20,
};

const SOP_STRATEGY_CN: BacktestStrategyParams = {
  ...ZHU_PROFIT_FORMULA_STRATEGY,
  entryType:   'nextClose',
  slippagePct: 0,
  holdDays:    30,           // 陸股延長持有（11-20天勝率100%）
};

/**
 * 陸股專用出場參數（根據診斷數據調整）
 * - 停用趨勢反轉（陸股勝率僅6%）
 * - 固定停損-5%（動態停損波動太大）
 * - 停用週線/季線出場（不適用陸股）
 * - 延長安全網到30天
 */
const CN_ZHU_EXIT: ZhuExitParams = {
  dynamicStopLoss:    false,
  fixedStopLossPct:   -0.05,
  maxStopLossPct:     -0.05,
  profitTakeMa5Pct:   0.10,
  profitClimaxPct:    0.20,
  enableLowerHigh:    false,   // 停用趨勢反轉
  enableStrongCover:  true,
  enableWeeklyResist: false,   // 停用週線遇壓
  enableSeasonLine:   false,   // 停用季線下彎
  maxHoldDays:        30,
};

/**
 * 模擬單筆交易：用朱家泓 SOP 獲利方程式決定出場
 *
 * @param symbol    股票代碼
 * @param name      股票名稱
 * @param market    市場
 * @param date      訊號日 (YYYY-MM-DD)
 * @param sixCondScore 六條件分數
 * @param candleIdx 訊號日在 candles 陣列中的索引
 * @param candles   完整的歷史 K 線（含指標）
 * @returns 交易結果，或 null（無法進場）
 */
export function simulateTrade(
  symbol:       string,
  name:         string,
  market:       MarketId,
  date:         string,
  sixCondScore: number,
  candleIdx:    number,
  candles:      CandleWithIndicators[],
  marketId:     'TW' | 'CN' = 'TW',
): TradeResult | null {
  // 收盤前進場：forwardCandles 從訊號日本身開始
  const startIdx = candleIdx;
  if (startIdx + 1 >= candles.length) return null; // 至少需要隔日 K 線供出場判斷

  // 建構 TradeSignal
  const signal: TradeSignal = {
    symbol,
    name,
    market,
    signalDate:    date,
    signalScore:   sixCondScore,
    signalReasons: [],
    trendState:    '',
    trendPosition: '',
    signalPrice:   candles[candleIdx].close,
  };

  // 建構 ForwardCandle[]（需要 ~60 根供 MA60 計算）
  const endIdx = Math.min(startIdx + 60, candles.length);
  const forwardCandles: ForwardCandle[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const c = candles[i];
    forwardCandles.push({
      date:   c.date,
      open:   c.open,
      high:   c.high,
      low:    c.low,
      close:  c.close,
      volume: c.volume ?? 0,
    });
  }

  // 呼叫 SOP 回測（陸股用不同出場參數）
  const strategy = marketId === 'CN' ? SOP_STRATEGY_CN : SOP_STRATEGY_TW;
  const exitParams = marketId === 'CN' ? CN_ZHU_EXIT : DEFAULT_ZHU_EXIT;
  const trade = runSOPBacktest(signal, forwardCandles, strategy, exitParams);
  if (!trade) return null;

  // 計算持有期間最大回撤
  const entryPrice = trade.entryPrice;
  let maxDD = 0;
  for (let i = 0; i < trade.holdDays && startIdx + i < candles.length; i++) {
    const low = candles[startIdx + i].low;
    const dd = (low - entryPrice) / entryPrice * 100;
    if (dd < maxDD) maxDD = dd;
  }

  return {
    entryDate:   trade.entryDate,
    entryPrice:  trade.entryPrice,
    exitDate:    trade.exitDate,
    exitPrice:   trade.exitPrice,
    netReturn:   trade.netReturn,
    grossReturn: trade.grossReturn,
    holdDays:    trade.holdDays,
    exitReason:  trade.exitReason,
    maxDrawdown: maxDD,
  };
}
