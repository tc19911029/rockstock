import { sanitizeScanResult, StockScanResult } from '../lib/scanner/types';

function mockResult(overrides?: Partial<StockScanResult>): StockScanResult {
  return {
    symbol: '2330.TW',
    name: '台積電',
    market: 'TW',
    price: 550,
    changePercent: 2.5,
    volume: 30000,
    triggeredRules: [],
    sixConditionsScore: 5,
    sixConditionsBreakdown: { trend: true, position: true, kbar: true, ma: true, volume: true, indicator: false },
    trendState: '多頭',
    trendPosition: '主升段',
    scanTime: '2024-01-15T13:30:00Z',
    ...overrides,
  };
}

describe('sanitizeScanResult', () => {
  it('passes through valid numeric fields unchanged', () => {
    const input = mockResult({ price: 550, changePercent: 2.5, sixConditionsScore: 5 });
    const result = sanitizeScanResult(input);
    expect(result.price).toBe(550);
    expect(result.changePercent).toBe(2.5);
    expect(result.sixConditionsScore).toBe(5);
  });

  it('replaces NaN with 0', () => {
    const input = mockResult({ price: NaN, changePercent: NaN, volume: NaN });
    const result = sanitizeScanResult(input);
    expect(result.price).toBe(0);
    expect(result.changePercent).toBe(0);
    expect(result.volume).toBe(0);
  });

  it('replaces undefined numeric fields with 0', () => {
    const input = mockResult({ price: undefined as unknown as number });
    const result = sanitizeScanResult(input);
    expect(result.price).toBe(0);
  });

  it('keeps optional fields as undefined if originally undefined', () => {
    const input = mockResult({ surgeScore: undefined, compositeScore: undefined });
    const result = sanitizeScanResult(input);
    expect(result.surgeScore).toBeUndefined();
    expect(result.compositeScore).toBeUndefined();
  });

  it('sanitizes optional fields when they are NaN', () => {
    const input = mockResult({ surgeScore: NaN, compositeScore: NaN, chipScore: NaN });
    const result = sanitizeScanResult(input);
    expect(result.surgeScore).toBe(0);
    expect(result.compositeScore).toBe(0);
    expect(result.chipScore).toBe(0);
  });

  it('preserves non-numeric fields', () => {
    const input = mockResult({ symbol: '2330.TW', name: '台積電', trendState: '多頭' });
    const result = sanitizeScanResult(input);
    expect(result.symbol).toBe('2330.TW');
    expect(result.name).toBe('台積電');
    expect(result.trendState).toBe('多頭');
  });
});
