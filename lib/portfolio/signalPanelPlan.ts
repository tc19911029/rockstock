import { PROFIT_TARGET_PRICE_MULT } from '@/lib/analysis/bookThresholds';
import type { V12Letter } from '@/lib/analysis/v12Signals';
import { getOperationMA, type OperationMode } from '@/lib/sell/v12Operation';

export function resolveSignalPanelOperatingMA(
  letter: V12Letter,
  operationMode: OperationMode = 'short',
) {
  return getOperationMA(letter, operationMode);
}

export function resolveHoldingProfitTarget(
  costPrice: number,
  entryPatternTarget?: number | null,
): { price: number; source: 'entry-pattern' | 'rule' } {
  if (entryPatternTarget != null && Number.isFinite(entryPatternTarget) && entryPatternTarget > 0) {
    return { price: entryPatternTarget, source: 'entry-pattern' };
  }
  return { price: costPrice * PROFIT_TARGET_PRICE_MULT, source: 'rule' };
}
