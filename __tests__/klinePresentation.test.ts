import { presentKLineAnalysis } from '@/lib/rules/klinePresentation';
import type { KLineSignalAnalysis } from '@/lib/rules/klineSignalAnalysis';

const buyAnalysis: KLineSignalAnalysis = {
  signal: {
    type: 'BUY',
    ruleId: 'smart-kline-buy',
    label: '智慧K線買進',
    description: '收盤突破前日最高',
    reason: '確認：突破前高時買進。',
  },
  family: '交易確認',
  direction: 'bullish',
  state: 'confirmed',
  stateLabel: '多方確認',
  interpretation: '測試',
  confirmation: '突破前高時買進。',
};

describe('K 線情境化呈現', () => {
  test.each(['exit', 'reduce', 'avoid-entry'] as const)(
    '%s 決策下，多方買進文字改成未採納觀察',
    action => {
      const result = presentKLineAnalysis(buyAnalysis, { action });
      expect(result.conflicting).toBe(true);
      expect(result.label).not.toContain('買進');
      expect(result.stateLabel).toBe('衝突未採納');
      expect(result.showConfirmation).toBe(false);
    },
  );

  test('評估進場時保留多方確認條件', () => {
    const result = presentKLineAnalysis(buyAnalysis, { action: 'evaluate-entry' });
    expect(result.conflicting).toBe(false);
    expect(result.label).toBe('智慧K線買進');
    expect(result.showConfirmation).toBe(true);
  });

  test('WATCH 狀態的智慧K線買進仍保留多方意圖', async () => {
    const { analyzeKLineSignal } = await import('@/lib/rules/klineSignalAnalysis');
    const result = analyzeKLineSignal({
      type: 'WATCH',
      ruleId: 'smart-kline-buy',
      label: '智慧K線買進',
      description: '等待斜率確認',
      reason: '做多：突破前高時買進。',
    });
    expect(result?.direction).toBe('bullish');
  });

  test('做空就緒時，多方 K 線標成方向衝突', () => {
    const result = presentKLineAnalysis(buyAnalysis, { preferredDirection: 'bearish' });
    expect(result.conflicting).toBe(true);
    expect(result.label).not.toContain('買進');
  });

  test('條件不足時不把任一方向型態寫成操作指示', () => {
    const result = presentKLineAnalysis(buyAnalysis, { suppressActionable: true });
    expect(result.conflicting).toBe(true);
    expect(result.showConfirmation).toBe(false);
  });
});
