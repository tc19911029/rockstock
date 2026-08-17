import type { CandleWithIndicators } from '@/types';
import { normalizeLetter } from '@/lib/scanner/buyMethodTracks';
import type { V12Letter } from '@/lib/analysis/v12Signals';
import {
  SIGNAL_TO_FIXED_STOP_PCT,
  updateStopLossDaily,
} from '@/lib/sell/v12StopLoss';
import { getTickSize } from '@/lib/utils/tickSize';
import type { MarketId } from '@/lib/scanner/types';

export interface DerivedHoldingStop {
  price: number;
  method: string;
  source: 'configured' | 'strategy_dynamic';
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
  market: MarketId;
  candles: CandleWithIndicators[];
  ui?: Record<string, unknown>;
}): DerivedHoldingStop {
  const normalizedLetter = normalizeLetter(args.triggerSignal ?? 'B');
  const letter = Object.prototype.hasOwnProperty.call(SIGNAL_TO_FIXED_STOP_PCT, normalizedLetter)
    ? normalizedLetter as V12Letter
    : 'B';
  const fixedPct = SIGNAL_TO_FIXED_STOP_PCT[letter] ?? 0.05;
  const uiEntry = args.ui?.entryKbar as Record<string, unknown> | undefined;
  const sourceEntry = args.candles.find(c => c.date === args.entryDate);
  const fallbackLow = args.entryPrice * (1 - fixedPct);
  const entryKbar = {
    open: finiteNumber(uiEntry?.open) ?? sourceEntry?.open ?? args.entryPrice,
    close: finiteNumber(uiEntry?.close) ?? sourceEntry?.close ?? args.entryPrice,
    low: finiteNumber(uiEntry?.low) ?? sourceEntry?.low ?? fallbackLow,
    high: finiteNumber(uiEntry?.high) ?? sourceEntry?.high ?? args.entryPrice,
  };
  const current = args.candles[args.candles.length - 1];
  if (!current) {
    const price = args.configuredStopLoss ?? fallbackLow;
    return { price, method: `固定 ${(fixedPct * 100).toFixed(0)}%（K線不足）`, source: args.configuredStopLoss ? 'configured' : 'strategy_dynamic' };
  }
  const entryIndex = Math.max(0, args.candles.findIndex(c => c.date >= args.entryDate));
  const recent = args.candles.slice(entryIndex);
  const recentHigh = finiteNumber(args.ui?.recentHigh) ?? Math.max(...recent.map(c => c.high));
  const supportLevel = finiteNumber(args.ui?.patternStopPrice)
    ?? finiteNumber(args.ui?.consolidationLow)
    ?? entryKbar.low;
  const highLevelBlowoff = sourceEntry != null
    && sourceEntry.avgVol5 != null && sourceEntry.avgVol5 > 0
    && sourceEntry.volume >= sourceEntry.avgVol5 * 1.5
    && sourceEntry.ma5 != null && sourceEntry.ma20 != null
    && sourceEntry.ma5 > sourceEntry.ma20;
  const dynamic = updateStopLossDaily({
    letter,
    entryPrice: args.entryPrice,
    entryKbar,
    tickSize: getTickSize(args.entryPrice, args.market),
    pivotLow: finiteNumber(args.ui?.vBottom) ?? entryKbar.low,
    supportLevel,
    triggerKLow: entryKbar.low,
    isEndPhase: args.ui?.endPhaseTriggered === true,
    recentHigh,
    highLevelBlowoff,
  }, current);
  const configured = args.configuredStopLoss;
  if (configured != null && configured >= dynamic.stopLossPrice) {
    return { price: configured, method: '使用者已設定停損（較緊）', source: 'configured' };
  }
  return { price: dynamic.stopLossPrice, method: dynamic.detail, source: 'strategy_dynamic' };
}
