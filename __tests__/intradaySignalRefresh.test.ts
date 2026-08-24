import { computeIndicators } from '@/lib/indicators';
import { resolveSignalEvaluationPhase } from '@/lib/portfolio/signalEvaluationPhase';
import { zhuShortMA5Exit } from '@/lib/rules/zhuRules';

const raw = [100, 101, 102, 103, 110, 90].map((close, index) => ({
  date: `2026-08-${String(19 + index).padStart(2, '0')}`,
  open: close,
  high: close + 2,
  low: close - 2,
  close,
  volume: 1_000,
}));

describe('盤中日 K 訊號刷新', () => {
  test('同一根日 K 跌破 MA5 後重新站回，MA5 出場訊號會自動解除', () => {
    const below = computeIndicators(raw);
    expect(zhuShortMA5Exit.evaluate(below, below.length - 1)?.ruleId).toBe('zhu-short-ma5-exit');

    const reclaimed = computeIndicators(raw.map((candle, index) => (
      index === raw.length - 1 ? { ...candle, close: 115, high: 116 } : candle
    )));
    const latest = reclaimed[reclaimed.length - 1];
    expect(latest.close).toBeGreaterThan(latest.ma5!);
    expect(zhuShortMA5Exit.evaluate(reclaimed, reclaimed.length - 1)).toBeNull();
  });

  test('只有最新一根今日日 K 在市場交易時段屬於盤中暫定', () => {
    const intraday = new Date('2026-08-24T03:44:00.000Z'); // 上海 11:44
    const afterClose = new Date('2026-08-24T07:01:00.000Z'); // 上海 15:01
    const base = {
      interval: '1d',
      currentIndex: 5,
      candleCount: 6,
      candleDate: '2026-08-24',
      market: 'CN' as const,
    };

    expect(resolveSignalEvaluationPhase({ ...base, now: intraday })).toBe('intraday');
    expect(resolveSignalEvaluationPhase({ ...base, now: afterClose })).toBe('closed');
    expect(resolveSignalEvaluationPhase({ ...base, currentIndex: 4, now: intraday })).toBe('closed');
    expect(resolveSignalEvaluationPhase({ ...base, interval: '5m', now: intraday })).toBe('closed');
    expect(resolveSignalEvaluationPhase({ ...base, candleDate: '2026-08-21', now: intraday })).toBe('closed');
  });
});
