import { deriveActiveLongStop, doesStopChangeLoosen, fallbackHoldingStop } from '@/lib/portfolio/holdingRisk';
import type { CandleWithIndicators } from '@/types';

describe('holding strategy stop', () => {
  test('未設定停損的 B 軌使用 5% ceiling，不再默認 7%', () => {
    const candles = [{
      date: '2026-08-17', open: 100, high: 104, low: 98, close: 103, volume: 1000,
      ma5: 101, ma10: 100, ma20: 99, avgVol5: 900,
    }] as never;
    const result = deriveActiveLongStop({
      entryPrice: 100,
      entryDate: '2026-08-17',
      triggerSignal: 'B',
      operationMode: 'short',
      managementStrategy: 'short-ma',
      market: 'TW',
      candles,
    });
    expect(result.price).toBeGreaterThanOrEqual(95);
    expect(result.source).toBe('strategy_dynamic');
  });

  test('既有較緊停損不可被策略值放寬', () => {
    const candles = [{
      date: '2026-08-17', open: 100, high: 104, low: 98, close: 103, volume: 1000,
      ma5: 101, ma10: 100, ma20: 99, avgVol5: 900,
    }] as never;
    const result = deriveActiveLongStop({
      entryPrice: 100, configuredStopLoss: 99, entryDate: '2026-08-17',
      triggerSignal: 'B', market: 'TW', candles,
      operationMode: 'short', managementStrategy: 'short-ma',
    });
    expect(result.price).toBe(99);
    expect(result.source).toBe('configured');
  });

  test('停損單向約束依 server 多空方向判斷', () => {
    expect(doesStopChangeLoosen(95, 94, 'long')).toBe(true);
    expect(doesStopChangeLoosen(95, 96, 'long')).toBe(false);
    expect(doesStopChangeLoosen(105, 106, 'short')).toBe(true);
    expect(doesStopChangeLoosen(105, 104, 'short')).toBe(false);
  });

  test('缺值停損做多為 -5%、做空為 +7%，不使用錯誤倒數換算', () => {
    expect(fallbackHoldingStop(100, 'long')).toBeCloseTo(95, 8);
    expect(fallbackHoldingStop(100, 'short')).toBeCloseTo(107, 8);
  });

  test('舊資料若帶未知 triggerSignal，明確退回保命線而非猜成 B', () => {
    const candles = [{
      date: '2026-08-17', open: 100, high: 104, low: 90, close: 103, volume: 1000,
      ma5: 101, ma10: 100, ma20: 99, avgVol5: 900,
    }] as never;
    const result = deriveActiveLongStop({
      entryPrice: 100, entryDate: '2026-08-17', triggerSignal: 'invalid', market: 'TW', candles,
    });
    expect(result.price).toBeGreaterThanOrEqual(95);
    expect(Number.isFinite(result.price)).toBe(true);
    expect(result.source).toBe('legacy_fallback');
    expect(result.method).toContain('策略資料待補');
  });

  test('歷史移動停損只會上移，不會因均線回落而放寬', () => {
    const candles = Array.from({ length: 30 }, (_, i) => {
      const close = i < 20 ? 100 + i : 120 - (i - 20) * 2;
      return {
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        open: close, high: close + 1, low: close - 1, close, volume: 1000,
        ma3: close, ma5: i < 24 ? 115 : 105, ma10: 108, ma20: 102, avgVol5: 900,
      };
    }) as CandleWithIndicators[];
    const full = deriveActiveLongStop({
      entryPrice: 100, entryDate: '2026-07-01', triggerSignal: 'B', operationMode: 'short',
      managementStrategy: 'short-ma', market: 'TW', candles,
    });
    const atPeak = deriveActiveLongStop({
      entryPrice: 100, entryDate: '2026-07-01', triggerSignal: 'B', operationMode: 'short',
      managementStrategy: 'short-ma', market: 'TW', candles: candles.slice(0, 24),
    });
    expect(full.price).toBeGreaterThanOrEqual(atPeak.price);
  });

  test('B 短線用 MA5、F 短線用 MA3，長線平常用 MA20', () => {
    const candles = Array.from({ length: 25 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      open: 100, high: 111, low: i === 0 ? 94 : 109, close: 110, volume: 1000,
      ma3: 108, ma5: 106, ma10: 104, ma20: 102, avgVol5: 900,
    })) as CandleWithIndicators[];
    const common = { entryPrice: 100, entryDate: '2026-06-01', operationMode: 'short' as const, managementStrategy: 'short-ma' as const, market: 'TW' as const, candles };
    const b = deriveActiveLongStop({ ...common, triggerSignal: 'B' });
    const f = deriveActiveLongStop({ ...common, triggerSignal: 'F' });
    const long = deriveActiveLongStop({ ...common, triggerSignal: 'B', operationMode: 'long', managementStrategy: 'ma20' });
    expect(b.method).toContain('MA5');
    expect(f.method).toContain('MA3');
    expect(long.method).toContain('MA20');
  });
});
