import type { Candle } from '@/types';
import { computeShadowLedger } from '@/lib/portfolio/shadowLedger';

function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    date: `2026-03-${String(i + 1).padStart(2, '0')}`,
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: 1000,
  }));
}

describe('影子帳本操作均線', () => {
  it('與 daily-action 共用長線 MA20 出場規則', () => {
    const bars = candles([...Array.from({ length: 29 }, () => 110), 100]);
    const result = computeShadowLedger({
      symbol: 'T',
      entryDate: bars[0].date,
      entryPrice: 100,
      shares: 1000,
      stopLoss: 80,
      candles: bars,
      triggerSignal: 'B',
      operationMode: 'long',
      managementStrategy: 'ma20',
    });
    expect(result?.events.at(-1)?.action).toBe('stop_loss');
    expect(result?.events.at(-1)?.label).toContain('MA20');
    expect(result?.remainingShares).toBe(0);
  });
});
