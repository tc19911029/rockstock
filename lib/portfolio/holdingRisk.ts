import type { CandleWithIndicators } from '@/types';
import { normalizeLetter } from '@/lib/scanner/buyMethodTracks';
import type { V12Letter } from '@/lib/analysis/v12Signals';
import {
  SIGNAL_TO_FIXED_STOP_PCT,
  updateStopLossDaily,
} from '@/lib/sell/v12StopLoss';
import { getTickSize } from '@/lib/utils/tickSize';
import type { MarketId } from '@/lib/scanner/types';
import { getOperationMA, type OperationMode } from '@/lib/sell/v12Operation';
import {
  parseHoldingManagementStrategy,
  parseHoldingOperationMode,
  parseHoldingTriggerSignal,
  type HoldingManagementStrategy,
} from '@/lib/portfolio/holdingStrategyContext';

export interface DerivedHoldingStop {
  price: number;
  method: string;
  source: 'configured' | 'strategy_dynamic' | 'legacy_fallback';
}

const DEFAULT_LONG_MISSING_STOP_PCT = 0.05;
const DEFAULT_SHORT_MISSING_STOP_PCT = 0.07;

export function fallbackHoldingStop(entryPrice: number, side: 'long' | 'short'): number {
  const pct = side === 'short' ? DEFAULT_SHORT_MISSING_STOP_PCT : DEFAULT_LONG_MISSING_STOP_PCT;
  return entryPrice * (side === 'short' ? 1 + pct : 1 - pct);
}

/** 判斷停損變更是否往不利方向放寬；方向必須來自 server holding 狀態。 */
export function doesStopChangeLoosen(
  existing: number,
  proposed: number,
  side: 'long' | 'short',
): boolean {
  return side === 'short' ? proposed > existing : proposed < existing;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 依進場字母與持倉狀態產生正式 active stop；做多停損永遠只收緊、不放寬。 */
export function deriveActiveLongStop(args: {
  entryPrice: number;
  configuredStopLoss?: number;
  entryDate: string;
  triggerSignal?: string;
  operationMode?: OperationMode;
  managementStrategy?: HoldingManagementStrategy;
  previousActiveStop?: number;
  market: MarketId;
  candles: CandleWithIndicators[];
  ui?: Record<string, unknown>;
}): DerivedHoldingStop {
  const parsedLetter = parseHoldingTriggerSignal(args.triggerSignal ?? args.ui?.triggerSignal);
  const operationMode = args.operationMode ?? parseHoldingOperationMode(args.ui?.operationMode);
  const managementStrategy = args.managementStrategy ?? parseHoldingManagementStrategy(args.ui?.managementStrategy);
  const configured = finiteNumber(args.configuredStopLoss);
  const persisted = finiteNumber(args.previousActiveStop);
  if (!parsedLetter || !operationMode || !managementStrategy) {
    const price = Math.max(configured ?? 0, persisted ?? 0, fallbackHoldingStop(args.entryPrice, 'long'));
    return {
      price,
      method: configured != null || persisted != null
        ? '策略資料待補；只沿用既有停損'
        : '策略資料待補；暫用做多 5% 保命線',
      source: configured != null || persisted != null ? 'configured' : 'legacy_fallback',
    };
  }
  const normalizedLetter = normalizeLetter(parsedLetter);
  const letter = normalizedLetter as V12Letter;
  const fixedPct = SIGNAL_TO_FIXED_STOP_PCT[letter] ?? 0.05;
  const uiEntry = args.ui?.entryKbar as Record<string, unknown> | undefined;
  const entryIndexFound = args.candles.findIndex(c => c.date >= args.entryDate);
  const entryIndex = entryIndexFound >= 0 ? entryIndexFound : 0;
  const sourceEntry = args.candles[entryIndex];
  const fallbackLow = args.entryPrice * (1 - fixedPct);
  const entryKbar = {
    open: finiteNumber(uiEntry?.open) ?? sourceEntry?.open ?? args.entryPrice,
    close: finiteNumber(uiEntry?.close) ?? sourceEntry?.close ?? args.entryPrice,
    low: finiteNumber(uiEntry?.low) ?? sourceEntry?.low ?? fallbackLow,
    high: finiteNumber(uiEntry?.high) ?? sourceEntry?.high ?? args.entryPrice,
  };
  const current = args.candles[args.candles.length - 1];
  if (!current) {
    const price = Math.max(configured ?? 0, persisted ?? 0, fallbackLow);
    return { price, method: `固定 ${(fixedPct * 100).toFixed(0)}%（K線不足）`, source: configured != null || persisted != null ? 'configured' : 'strategy_dynamic' };
  }
  const recent = args.candles.slice(entryIndex);
  const supportLevel = finiteNumber(args.ui?.patternStopPrice)
    ?? finiteNumber(args.ui?.consolidationLow)
    ?? entryKbar.low;
  const highLevelBlowoff = sourceEntry != null
    && sourceEntry.avgVol5 != null && sourceEntry.avgVol5 > 0
    && sourceEntry.volume >= sourceEntry.avgVol5 * 1.5
    && sourceEntry.ma5 != null && sourceEntry.ma20 != null
    && sourceEntry.ma5 > sourceEntry.ma20;
  let activePrice = Math.max(configured ?? 0, persisted ?? 0, fallbackLow);
  let activeMethod = configured != null || persisted != null ? '沿用既有停損' : `固定 ${(fixedPct * 100).toFixed(0)}%`;
  const explicitRecentHigh = finiteNumber(args.ui?.recentHigh);
  let highestClose = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < recent.length; i++) {
    const candle = recent[i];
    highestClose = Math.max(highestClose, candle.close);
    const profitPct = (candle.close - args.entryPrice) / args.entryPrice;
    const endPhase = args.ui?.endPhaseTriggered === true && i === recent.length - 1;
    const modeForStrategy: OperationMode = managementStrategy === 'ma20' ? 'long' : 'short';
    const strategyMa = managementStrategy === 'kline' || managementStrategy === 'triple-ma'
      ? null
      : getOperationMA(letter, modeForStrategy);
    // 長線已賺逾 20% 或明確進入末升段，才收緊到 MA5；平常長線仍守 MA20。
    const trailingMA = managementStrategy === 'ma20' && (profitPct >= 0.20 || endPhase)
      ? 'MA5' as const
      : strategyMa;
    const dynamic = updateStopLossDaily({
      letter,
      entryPrice: args.entryPrice,
      entryKbar,
      tickSize: getTickSize(args.entryPrice, args.market),
      pivotLow: finiteNumber(args.ui?.vBottom) ?? entryKbar.low,
      supportLevel,
      triggerKLow: entryKbar.low,
      isEndPhase: endPhase,
      recentHigh: Math.max(highestClose, explicitRecentHigh ?? Number.NEGATIVE_INFINITY),
      highLevelBlowoff,
      trailingMAOverride: trailingMA,
      trailingBufferMult: 0.995,
    }, candle);
    if (dynamic.stopLossPrice > activePrice) {
      activePrice = dynamic.stopLossPrice;
      activeMethod = dynamic.detail;
    }
  }
  return {
    price: activePrice,
    method: activeMethod,
    source: activePrice === configured || activePrice === persisted ? 'configured' : 'strategy_dynamic',
  };
}
