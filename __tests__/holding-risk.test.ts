import { deriveActiveLongStop, doesStopChangeLoosen, fallbackHoldingStop } from '@/lib/portfolio/holdingRisk';

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

  test('舊資料若帶未知 triggerSignal，安全退回 B 軌而非產生 NaN/10% 停損', () => {
    const candles = [{
      date: '2026-08-17', open: 100, high: 104, low: 90, close: 103, volume: 1000,
      ma5: 101, ma10: 100, ma20: 99, avgVol5: 900,
    }] as never;
    const result = deriveActiveLongStop({
      entryPrice: 100, entryDate: '2026-08-17', triggerSignal: 'invalid', market: 'TW', candles,
    });
    expect(result.price).toBeGreaterThanOrEqual(95);
    expect(Number.isFinite(result.price)).toBe(true);
  });
});
