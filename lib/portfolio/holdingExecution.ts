import type {
  PortfolioExecutionState,
  PortfolioHolding,
  PortfolioPartialExitExecution,
} from '@/lib/agents/portfolio/types';

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
  if (!input.signalType.trim()) throw new Error('signalType 不可空白');
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
