import type { KLineSignalAnalysis } from './klineSignalAnalysis';
import type { NarrativeAction } from '@/lib/narrative/types';

export interface KLinePresentationContext {
  readonly action?: NarrativeAction;
  readonly preferredDirection?: 'bullish' | 'bearish';
  readonly suppressActionable?: boolean;
}

export interface KLinePresentation {
  readonly label: string;
  readonly stateLabel: string;
  readonly conflicting: boolean;
  readonly conflictNote?: string;
  readonly showConfirmation: boolean;
}

function safeObservationLabel(label: string, direction: KLineSignalAnalysis['direction']): string {
  const directionLabel = direction === 'bullish' ? '多方訊號' : direction === 'bearish' ? '空方訊號' : '觀察訊號';
  return label
    .replace(/買進|做多|進場/g, directionLabel)
    .replace(/賣出|做空|出場/g, directionLabel);
}

export function presentKLineAnalysis(
  analysis: KLineSignalAnalysis,
  context?: KLinePresentationContext,
): KLinePresentation {
  const riskFirst = context?.action === 'exit'
    || context?.action === 'reduce'
    || context?.action === 'avoid-entry';
  const entryFirst = context?.action === 'evaluate-entry';
  const directionConflict = context?.preferredDirection != null
    && analysis.direction !== 'neutral'
    && analysis.direction !== context.preferredDirection;
  const conflicting = context?.suppressActionable === true
    ? analysis.direction !== 'neutral'
    : directionConflict
    || (riskFirst && analysis.direction === 'bullish')
    || (entryFirst && analysis.direction === 'bearish')
    || (context?.action === 'hold' && analysis.direction === 'bearish');

  if (!conflicting) {
    return {
      label: analysis.signal.label,
      stateLabel: analysis.stateLabel,
      conflicting: false,
      showConfirmation: true,
    };
  }

  return {
    label: safeObservationLabel(analysis.signal.label, analysis.direction),
    stateLabel: '衝突未採納',
    conflicting: true,
    conflictNote: '此型態與目前主決策衝突，只保留辨識紀錄，不作為本次操作指示。',
    showConfirmation: false,
  };
}
