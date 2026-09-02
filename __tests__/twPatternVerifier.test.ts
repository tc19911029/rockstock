import type { Candle } from '@/types';
import { _resetDetectorMemoryForTest, type DetectorContext, type Signal } from '@/lib/realtime/blowoffDetector';
import { verifyTWPatternCandidates } from '@/lib/realtime/TWPatternVerifier';

const NOW = new Date('2026-09-02T03:19:30.000Z'); // 台北 11:19:30
const CTX: DetectorContext = { symbol: '2330.TW', market: 'TW', isHolding: true, source: 'holding' };

function candles(lastBearish = true): Candle[] {
  return Array.from({ length: 20 }, (_, index) => {
    const latest = index === 19;
    return {
      date: `2026-09-02 11:${String(index).padStart(2, '0')}`,
      open: 100,
      high: latest && lastBearish ? 101 : 100,
      low: latest && lastBearish ? 94 : 100,
      close: latest && lastBearish ? 95 : 100,
      volume: latest ? 1_000_000 : 100_000,
    };
  });
}

function candidate(): Signal {
  return {
    rule: 'blowoff-bearish', symbol: '2330.TW', market: 'TW',
    ts: new Date('2026-09-02T11:19:00+08:00').getTime(), tfMin: 1,
    meta: {
      open: 100, high: 101, low: 94, close: 95, volume: 9999,
      volumeMultiplier: 99, pctChange: -5, bodyRatio: 0.71,
    },
    caveat: 'minute-inference', isHolding: true, source: 'holding',
  };
}

describe('台股形態訊號 Fugle 精準驗證', () => {
  beforeEach(() => _resetDetectorMemoryForTest());

  test('精準分鐘 K 同樣成立才放行，且 meta 改用 Fugle 數值', async () => {
    const result = await verifyTWPatternCandidates([candidate()], CTX, {
      fetchCandles: async () => candles(true),
      now: () => NOW,
    });

    expect(result.status).toBe('verified');
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].meta.volume).toBe(1000); // 股 → 張
    expect(result.signals[0].meta.volumeMultiplier).toBeLessThan(10);
  });

  test('MIS 假候選在 Fugle K 不成立時拒絕', async () => {
    const result = await verifyTWPatternCandidates([candidate()], CTX, {
      fetchCandles: async () => candles(false),
      now: () => NOW,
    });

    expect(result).toMatchObject({ status: 'rejected', signals: [] });
  });

  test('Fugle 最新 K 超過 150 秒時拒絕，避免拿舊資料確認新訊號', async () => {
    const result = await verifyTWPatternCandidates([candidate()], CTX, {
      fetchCandles: async () => candles(true),
      now: () => new Date('2026-09-02T03:23:00.000Z'),
    });

    expect(result).toMatchObject({ status: 'stale', signals: [] });
  });
});
