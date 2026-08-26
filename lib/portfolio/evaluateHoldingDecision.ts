import type { Candle, CandleWithIndicators } from '@/types';
import type { MarketId } from '@/lib/scanner/types';
import { computeIndicators } from '@/lib/indicators';
import { evaluateHolding, type HoldingActionResult } from '@/lib/agents/holdingsActionEngine';
import type { EntryGateThresholds } from '@/lib/agents/entryGate';
import { deriveActiveLongStop, fallbackHoldingStop, type DerivedHoldingStop } from './holdingRisk';
import { resolveHoldingStrategyContext, type HoldingStrategyContext } from './holdingStrategyContext';

export interface HoldingDecisionInput {
  symbol: string;
  market: MarketId;
  entryDate: string;
  entryPrice: number;
  configuredStopLoss?: number;
  previousActiveStop?: number;
  candles: Candle[];
  ui?: Record<string, unknown>;
  thresholds?: EntryGateThresholds;
  priorPartialExit?: { signalDate: string; sharesRemaining: number };
}

export interface HoldingDecision {
  context: HoldingStrategyContext;
  activeStop: DerivedHoldingStop;
  result: HoldingActionResult;
  candles: CandleWithIndicators[];
  entryKlineLow?: number;
}

/**
 * 每日面板、持股卡、影子帳本與即時監控的單一持股決策入口。
 * 呼叫端不再各自補 B、short 或 7% 停損。
 */
export function evaluateHoldingDecision(input: HoldingDecisionInput): HoldingDecision {
  const context = resolveHoldingStrategyContext(input.ui);
  const candles = computeIndicators(input.candles);
  const latest = candles[candles.length - 1];
  if (!latest) throw new RangeError('candles must not be empty');

  const positionSide: 'long' | 'short' = input.ui?.positionSide === 'short' ? 'short' : 'long';
  const entryKbar = input.ui?.entryKbar as { high?: unknown; low?: unknown } | undefined;
  const entryCandle = candles.find(candle => candle.date >= input.entryDate);
  const entryKlineLow = typeof entryKbar?.low === 'number' && Number.isFinite(entryKbar.low)
    ? entryKbar.low
    : entryCandle?.low;
  const entryHigh = typeof entryKbar?.high === 'number' && Number.isFinite(entryKbar.high)
    ? entryKbar.high
    : entryCandle?.high;

  const activeStop: DerivedHoldingStop = positionSide === 'long'
    ? deriveActiveLongStop({
        entryPrice: input.entryPrice,
        configuredStopLoss: input.configuredStopLoss,
        previousActiveStop: input.previousActiveStop,
        entryDate: input.entryDate,
        triggerSignal: context.triggerSignal,
        operationMode: context.operationMode,
        managementStrategy: context.managementStrategy,
        market: input.market,
        candles,
        ui: input.ui,
      })
    : {
        price: input.configuredStopLoss ?? input.previousActiveStop ?? fallbackHoldingStop(input.entryPrice, 'short'),
        method: input.configuredStopLoss != null || input.previousActiveStop != null
          ? '使用者已設定回補停損'
          : '做空 7% 回補保命線',
        source: input.configuredStopLoss != null || input.previousActiveStop != null ? 'configured' : 'legacy_fallback',
      };

  const result = evaluateHolding({
    symbol: input.symbol,
    entryPrice: input.entryPrice,
    stopLoss: activeStop.price,
    candles,
    todayClose: latest.close,
    thresholds: input.thresholds,
    triggerSignal: context.triggerSignal,
    operationMode: context.operationMode,
    managementStrategy: context.managementStrategy,
    strategyContextKnown: positionSide === 'short' || context.status === 'known',
    entryDate: input.entryDate,
    positionSide,
    entryHigh,
    entryKlineLow,
    priorPartialExit: input.priorPartialExit,
  });

  return { context, activeStop, result, candles, entryKlineLow };
}
