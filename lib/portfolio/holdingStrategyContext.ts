import type { V12Letter } from '@/lib/analysis/v12Signals';
import type { OperationMode } from '@/lib/sell/v12Operation';

/**
 * 持股建立後只能選一套主要管理法。`short-ma` 會依進場字母取老師指定的
 * 短線均線（例如 B=MA5、F=MA3），不是把所有短線部位一律猜成 MA5。
 */
export type HoldingManagementStrategy = 'kline' | 'short-ma' | 'ma20' | 'triple-ma';

export type HoldingStrategyContext =
  | {
      status: 'known';
      triggerSignal: V12Letter;
      operationMode: OperationMode;
      managementStrategy: HoldingManagementStrategy;
    }
  | {
      status: 'unknown';
      triggerSignal?: V12Letter;
      operationMode?: OperationMode;
      managementStrategy?: HoldingManagementStrategy;
      missing: Array<'triggerSignal' | 'operationMode' | 'managementStrategy'>;
    };

const LETTERS = new Set<V12Letter>([
  'A', 'B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q',
]);

export function parseHoldingTriggerSignal(value: unknown): V12Letter | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().toUpperCase();
  const normalized = (({ G: 'J', H: 'L', I: 'K' } as Record<string, string>)[raw] ?? raw) as V12Letter;
  return LETTERS.has(normalized) ? normalized : undefined;
}

export function parseHoldingOperationMode(value: unknown): OperationMode | undefined {
  return value === 'short' || value === 'long' ? value : undefined;
}

export function parseHoldingManagementStrategy(value: unknown): HoldingManagementStrategy | undefined {
  // 早期試作曾使用 ma5；讀取時升級成較精確的 short-ma，避免 F 被誤套 MA5。
  if (value === 'ma5') return 'short-ma';
  return value === 'kline' || value === 'short-ma' || value === 'ma20' || value === 'triple-ma'
    ? value
    : undefined;
}

/** 不補預設值：缺一項就明確回 unknown，讓各決策面顯示「策略待補」。 */
export function resolveHoldingStrategyContext(ui: Record<string, unknown> | undefined): HoldingStrategyContext {
  const triggerSignal = parseHoldingTriggerSignal(ui?.triggerSignal);
  const operationMode = parseHoldingOperationMode(ui?.operationMode);
  const managementStrategy = parseHoldingManagementStrategy(ui?.managementStrategy);
  const missing: Array<'triggerSignal' | 'operationMode' | 'managementStrategy'> = [];
  if (!triggerSignal) missing.push('triggerSignal');
  if (!operationMode) missing.push('operationMode');
  if (!managementStrategy) missing.push('managementStrategy');
  if (managementStrategy === 'short-ma' && operationMode && operationMode !== 'short') missing.push('operationMode');
  if (managementStrategy === 'ma20' && operationMode && operationMode !== 'long') missing.push('operationMode');
  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length > 0) {
    return { status: 'unknown', triggerSignal, operationMode, managementStrategy, missing: uniqueMissing };
  }
  return {
    status: 'known',
    triggerSignal: triggerSignal!,
    operationMode: operationMode!,
    managementStrategy: managementStrategy!,
  };
}

export function managementStrategyLabel(value: HoldingManagementStrategy): string {
  switch (value) {
    case 'kline': return '智慧 K 線法';
    case 'short-ma': return '短線訊號均線';
    case 'ma20': return 'MA20 長線法';
    case 'triple-ma': return 'MA5／MA10／MA20 分批法';
  }
}
