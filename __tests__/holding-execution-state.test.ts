import {
  BLOWOFF_PARTIAL_EXIT_SIGNAL_TYPE_SET,
  PARTIAL_EXIT_SIGNAL_TYPE_SET,
  confirmPartialExit,
  partialExitForSignal,
} from '@/lib/portfolio/holdingExecution';
import type { PortfolioHolding } from '@/lib/agents/portfolio/types';

const holding = (shares = 9): PortfolioHolding => ({
  schemaVersion: 1,
  symbol: '2330.TW',
  name: '測試',
  market: 'TW',
  entryDate: '2026-08-01',
  entryPrice: 100,
  shares,
  status: 'open',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
});

describe('holding execution state', () => {
  test('確認賣半會保存執行證據並更新剩餘股數', () => {
    const result = confirmPartialExit(holding(), {
      signalDate: '2026-08-17',
      signalType: 'ch9_partial_tp_half',
      executedAt: '2026-08-17T05:25:00.000Z',
      executionPrice: 120,
    });
    expect(result.execution.sharesSold).toBe(4);
    expect(result.shares).toBe(5);
    expect(partialExitForSignal(result.executionState, '2026-08-17')?.sharesRemaining).toBe(5);
  });

  test('相同訊號重送具冪等性，不會再砍一半', () => {
    const first = confirmPartialExit(holding(10), {
      signalDate: '2026-08-17', signalType: 'break_ma5_short', executedAt: '2026-08-17T05:25:00.000Z',
    });
    const second = confirmPartialExit({ ...holding(first.shares), executionState: first.executionState }, {
      signalDate: '2026-08-17', signalType: 'break_ma5_short', executedAt: '2026-08-17T05:26:00.000Z',
    });
    expect(second.shares).toBe(5);
    expect(second.executionState.partialExits).toHaveLength(1);
  });

  test('只接受正式減半訊號，且 MA5 減半不冒充隔日爆量反轉狀態', () => {
    expect(PARTIAL_EXIT_SIGNAL_TYPE_SET.has('break_ma5_short')).toBe(true);
    expect(BLOWOFF_PARTIAL_EXIT_SIGNAL_TYPE_SET.has('break_ma5_short')).toBe(false);
    expect(() => confirmPartialExit(holding(10), {
      signalDate: '2026-08-17', signalType: 'arbitrary_half', executedAt: '2026-08-17T05:25:00.000Z',
    })).toThrow('不允許的分批出場');
  });
});
