import type {
  PortfolioExecutionState,
  PortfolioHolding,
  PortfolioPartialExitExecution,
} from '@/lib/agents/portfolio/types';

export const PARTIAL_EXIT_SIGNAL_TYPES = [
  'ch9_partial_tp_half',
  'ch83_surge3_blowoff_reduce',
  'ch8_climax_partial_tp',
  'blowoff_black_reduce',
  'blowoff_upper_shadow_reduce',
  'break_ma5_short',
] as const;

export type PartialExitSignalType = typeof PARTIAL_EXIT_SIGNAL_TYPES[number];
export const PARTIAL_EXIT_SIGNAL_TYPE_SET: ReadonlySet<string> = new Set(PARTIAL_EXIT_SIGNAL_TYPES);
export const BLOWOFF_PARTIAL_EXIT_SIGNAL_TYPE_SET: ReadonlySet<string> = new Set(
  PARTIAL_EXIT_SIGNAL_TYPES.filter(type => type !== 'break_ma5_short'),
);

export function isPartialExitSignalType(value: string): value is PartialExitSignalType {
  return PARTIAL_EXIT_SIGNAL_TYPE_SET.has(value);
}

export interface ConfirmPartialExitInput {
  signalDate: string;
  signalType: string;
  executedAt: string;
  executionPrice?: number;
}

/**
 * 將「已執行賣半」轉成可保存狀態。此函式只處理帳務狀態，不自行假設使用者有成交。
 * 奇數股採向下取整賣出，至少保留 1 股；1 股部位無法減半。
 */
export function confirmPartialExit(
  holding: PortfolioHolding,
  input: ConfirmPartialExitInput,
): { shares: number; executionState: PortfolioExecutionState; execution: PortfolioPartialExitExecution } {
  if (holding.status !== 'open') throw new Error('只有 open holding 可以確認分批賣出');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.signalDate)) throw new Error('signalDate 格式錯誤');
  if (!isPartialExitSignalType(input.signalType)) throw new Error(`不允許的分批出場 signalType: ${input.signalType}`);
  if (!Number.isInteger(holding.shares) || holding.shares < 2) throw new Error('持股少於 2 股，無法執行賣半');

  const previous = holding.executionState ?? {
    initialShares: holding.shares,
    partialExits: [],
  };
  const duplicate = previous.partialExits.find(execution =>
    execution.signalDate === input.signalDate && execution.signalType === input.signalType,
  );
  if (duplicate) {
    return { shares: holding.shares, executionState: previous, execution: duplicate };
  }

  const sharesSold = Math.floor(holding.shares / 2);
  const sharesRemaining = holding.shares - sharesSold;
  const execution: PortfolioPartialExitExecution = {
    signalDate: input.signalDate,
    signalType: input.signalType,
    executedAt: input.executedAt,
    ...(input.executionPrice != null ? { executionPrice: input.executionPrice } : {}),
    sharesBefore: holding.shares,
    sharesSold,
    sharesRemaining,
  };
  const executionState: PortfolioExecutionState = {
    initialShares: previous.initialShares,
    partialExits: [...previous.partialExits, execution],
  };
  return { shares: sharesRemaining, executionState, execution };
}

export function partialExitForSignal(
  state: PortfolioExecutionState | undefined,
  signalDate: string,
  signalTypes?: ReadonlySet<string>,
): PortfolioPartialExitExecution | null {
  if (!state) return null;
  return [...state.partialExits].reverse().find(execution =>
    execution.signalDate === signalDate && (!signalTypes || signalTypes.has(execution.signalType)),
  ) ?? null;
}
