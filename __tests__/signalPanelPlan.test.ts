import {
  resolveHoldingProfitTarget,
  resolveSignalPanelOperatingMA,
} from '@/lib/portfolio/signalPanelPlan';

describe('訊號面板持倉計畫', () => {
  test('持倉升級長線後改守 MA20', () => {
    expect(resolveSignalPanelOperatingMA('B', 'short')).toBe('MA5');
    expect(resolveSignalPanelOperatingMA('B', 'long')).toBe('MA20');
  });

  test('Q 三均線戰法不被長線模式改寫', () => {
    expect(resolveSignalPanelOperatingMA('Q', 'long')).toBe('MA10');
  });

  test('停利優先讀進場時凍結的型態目標', () => {
    expect(resolveHoldingProfitTarget(100, 128)).toEqual({
      price: 128,
      source: 'entry-pattern',
    });
  });

  test('沒有進場型態快照時才使用 10% 紀律', () => {
    const result = resolveHoldingProfitTarget(100);
    expect(result.source).toBe('rule');
    expect(result.price).toBeCloseTo(110);
  });
});
