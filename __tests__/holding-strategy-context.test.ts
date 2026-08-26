import { resolveHoldingStrategyContext } from '@/lib/portfolio/holdingStrategyContext';

describe('holding strategy context', () => {
  test('缺欄位不猜 B 或短線', () => {
    const context = resolveHoldingStrategyContext({});
    expect(context.status).toBe('unknown');
    expect(context.triggerSignal).toBeUndefined();
    expect(context.operationMode).toBeUndefined();
  });

  test('完整三欄才成為正式策略上下文', () => {
    expect(resolveHoldingStrategyContext({
      triggerSignal: 'B', operationMode: 'short', managementStrategy: 'short-ma',
    })).toEqual({
      status: 'known', triggerSignal: 'B', operationMode: 'short', managementStrategy: 'short-ma',
    });
  });

  test('舊 G/H/I 字母會轉成目前 J/L/K，不會默認 B', () => {
    expect(resolveHoldingStrategyContext({
      triggerSignal: 'G', operationMode: 'short', managementStrategy: 'short-ma',
    })).toMatchObject({ status: 'known', triggerSignal: 'J' });
  });
});
