import type { Candle } from '@/types';
import { evaluateHoldingDecision } from '@/lib/portfolio/evaluateHoldingDecision';
import { computeShadowLedger } from '@/lib/portfolio/shadowLedger';
import { buildChartNarrative } from '@/lib/narrative/buildChartNarrative';

function candles(lastClose = 98): Candle[] {
  return Array.from({ length: 25 }, (_, i) => {
    const close = i === 24 ? lastClose : 100;
    return {
      date: `2026-07-${String(i + 1).padStart(2, '0')}`,
      open: close, high: close + 1, low: close - 1, close, volume: 1000,
    };
  });
}

describe('holding decision parity', () => {
  test('正式決策、走圖主卡與影子帳本同日都是出場', () => {
    const bars = candles();
    const ui = { triggerSignal: 'B', operationMode: 'short', managementStrategy: 'short-ma' };
    const decision = evaluateHoldingDecision({
      symbol: 'T', market: 'TW', entryDate: bars[0].date, entryPrice: 100,
      configuredStopLoss: 99, candles: bars, ui,
    });
    expect(decision.result.action).toBe('stop_loss');

    const shadow = computeShadowLedger({
      symbol: 'T', entryDate: bars[0].date, entryPrice: 100, shares: 300,
      stopLoss: 99, candles: bars, triggerSignal: 'B', operationMode: 'short',
      managementStrategy: 'short-ma', ui,
    });
    expect(shadow?.events.at(-1)?.action).toBe('stop_loss');

    const formalSignal = decision.result.signals[0];
    const narrative = buildChartNarrative({
      candles: decision.candles,
      currentIndex: decision.candles.length - 1,
      signals: [],
      hasPosition: true,
      holdingDecision: {
        action: 'exit',
        label: formalSignal.label,
        detail: formalSignal.detail,
      },
    });
    expect(narrative.action).toBe('exit');
    expect(narrative.primaryEvent.sourceFamily).toBe('正式持股引擎');
  });

  test('缺策略明確待補，不會得到 B／短線的出場結論', () => {
    const bars = candles(105);
    const decision = evaluateHoldingDecision({
      symbol: 'T', market: 'TW', entryDate: bars[0].date, entryPrice: 100,
      configuredStopLoss: 95, candles: bars, ui: {},
    });
    expect(decision.context.status).toBe('unknown');
    expect(decision.result.action).toBe('strategy_required');
    expect(decision.result.signals[0].type).toBe('strategy_context_missing');
  });
});
