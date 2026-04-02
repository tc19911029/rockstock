/**
 * Signal conversion utilities — converts scanner results to
 * BacktestEngine-compatible TradeSignal format.
 *
 * Extracted from BacktestEngine.ts for modularity.
 */

import { StockScanResult } from '@/lib/scanner/types';
import type { TradeSignal, BacktestStrategyParams } from './BacktestEngine';

/**
 * Convert a scan result to a universal trade signal.
 * This is the bridge between scanner output and the backtest engine.
 */
export function scanResultToSignal(scanResult: StockScanResult): TradeSignal {
  const { sixConditionsBreakdown, sixConditionsScore, trendState, trendPosition } = scanResult;
  const reasons: string[] = [];
  if (sixConditionsBreakdown.trend)     reasons.push('趨勢多頭');
  if (sixConditionsBreakdown.position)  reasons.push('位置良好');
  if (sixConditionsBreakdown.kbar)      reasons.push('K棒長紅');
  if (sixConditionsBreakdown.ma)        reasons.push('均線多排');
  if (sixConditionsBreakdown.volume)    reasons.push('量能放大');
  if (sixConditionsBreakdown.indicator) reasons.push('指標配合');

  return {
    symbol:        scanResult.symbol,
    name:          scanResult.name,
    market:        scanResult.market,
    industry:      scanResult.industry,
    signalDate:    scanResult.scanTime.split('T')[0],
    signalScore:   sixConditionsScore,
    signalReasons: reasons,
    trendState,
    trendPosition,
    surgeScore:    scanResult.surgeScore,
    surgeGrade:    scanResult.surgeGrade,
    histWinRate:   scanResult.histWinRate,
    smartMoneyScore: scanResult.smartMoneyScore,
    compositeScore:  scanResult.compositeScore,
    retailSentiment: scanResult.retailSentiment,
    contrarianSignal: scanResult.contrarianSignal,
    volatilityRegime: scanResult.volatilityRegime,
    highWinRateTypes: scanResult.highWinRateTypes,
    highWinRateScore: scanResult.highWinRateScore,
    winnerBullishPatterns: scanResult.winnerBullishPatterns,
    winnerBearishPatterns: scanResult.winnerBearishPatterns,
    eliminationPenalty: scanResult.eliminationPenalty,
    direction: scanResult.direction,
    signalPrice: scanResult.price,
  };
}

/**
 * Adaptive exit parameters based on signal quality.
 * Higher quality signals get longer hold + wider trailing stop.
 */
export function resolveAdaptiveParams(
  signal: TradeSignal,
  baseStrategy: BacktestStrategyParams,
): BacktestStrategyParams {
  const grade = signal.surgeGrade ?? 'C';
  const composite = signal.compositeScore ?? 50;

  let holdDays = baseStrategy.holdDays;
  if (grade === 'S') holdDays = Math.max(holdDays, 8);
  else if (grade === 'A') holdDays = Math.max(holdDays, 7);
  else if (grade === 'D') holdDays = Math.min(holdDays, 4);

  let trailingStop = baseStrategy.trailingStop;
  let trailingActivate = baseStrategy.trailingActivate;
  if (composite >= 70 && trailingStop !== null) {
    trailingStop = Math.max(trailingStop, 0.05);
    trailingActivate = trailingActivate !== null ? Math.max(trailingActivate, 0.07) : 0.07;
  } else if (composite < 40 && trailingStop !== null) {
    trailingStop = Math.min(trailingStop, 0.02);
    trailingActivate = trailingActivate !== null ? Math.min(trailingActivate, 0.03) : 0.03;
  }

  let stopLoss = baseStrategy.stopLoss;
  if (composite < 40 && stopLoss !== null) {
    stopLoss = Math.max(stopLoss, -0.04);
  }

  if (signal.contrarianSignal === 'bearish') {
    holdDays = Math.max(2, holdDays - 2);
    if (stopLoss !== null) stopLoss = Math.max(stopLoss, -0.04);
  } else if (signal.contrarianSignal === 'bullish') {
    holdDays = Math.min(holdDays + 1, 10);
  }

  const volRegime = signal.volatilityRegime;
  if (volRegime === 'EXTREME') {
    if (stopLoss !== null) stopLoss = stopLoss * 1.5;
    holdDays = Math.max(2, Math.round(holdDays * 0.6));
  } else if (volRegime === 'HIGH') {
    if (stopLoss !== null) stopLoss = stopLoss * 1.25;
    holdDays = Math.max(2, Math.round(holdDays * 0.8));
  } else if (volRegime === 'LOW') {
    if (stopLoss !== null) stopLoss = Math.max(stopLoss, stopLoss * 0.75);
    holdDays = Math.min(12, Math.round(holdDays * 1.3));
  }

  return {
    ...baseStrategy,
    holdDays,
    trailingStop,
    trailingActivate,
    stopLoss,
  };
}
