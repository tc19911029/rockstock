import { fetchCNRealtimeQuoteBatch } from '@/lib/realtime/CNRealtimeQuoteSource';
import type { EastMoneyQuote } from '@/lib/datasource/EastMoneyRealtime';
import type { IntradaySnapshot } from '@/lib/datasource/IntradayCache';

const NOW = new Date('2026-08-25T03:30:00.000Z');

function quote(code: string, close: number): EastMoneyQuote {
  return {
    code,
    name: code,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1000,
    prevClose: close - 0.5,
  };
}

function snapshot(updatedAt = '2026-08-25T03:29:00.000Z'): IntradaySnapshot {
  return {
    market: 'CN',
    date: '2026-08-25',
    updatedAt,
    count: 1,
    quotes: [{
      symbol: '603986', name: '兆易創新', open: 100, high: 103, low: 99,
      close: 102, volume: 5000, prevClose: 101, changePercent: 0.99,
    }],
  };
}

describe('A 股 realtime-scan 報價備援', () => {
  test('Tencent 命中全部監看股時不呼叫其他來源', async () => {
    const fetchSina = jest.fn(async () => new Map<string, EastMoneyQuote>());
    const readSnapshot = jest.fn(async () => null);
    const result = await fetchCNRealtimeQuoteBatch(['603986.SS'], {
      fetchTencent: async () => new Map([['603986', quote('603986', 102)]]),
      fetchSina,
      readSnapshot,
      now: () => NOW,
    });

    expect(result.source).toBe('tencent');
    expect(result.quotes.get('603986')?.close).toBe(102);
    expect(fetchSina).not.toHaveBeenCalled();
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  test('Tencent 空資料時改用 Sina 目標批次', async () => {
    const result = await fetchCNRealtimeQuoteBatch(['000001.SZ'], {
      fetchTencent: async () => new Map(),
      fetchSina: async () => new Map([['000001', quote('000001', 12.3)]]),
      readSnapshot: async () => null,
      now: () => NOW,
    });

    expect(result.source).toBe('sina');
    expect(result.quotes.get('000001')?.close).toBe(12.3);
  });

  test('兩個即時來源都空時使用六分鐘內 L2 快照', async () => {
    const result = await fetchCNRealtimeQuoteBatch(['603986.SS'], {
      fetchTencent: async () => new Map(),
      fetchSina: async () => new Map(),
      readSnapshot: async () => snapshot(),
      now: () => NOW,
    });

    expect(result.source).toBe('l2-snapshot');
    expect(result.quotes.get('603986')).toMatchObject({ close: 102, high: 103, prevClose: 101 });
  });

  test('拒絕超過新鮮度門檻的 L2 快照', async () => {
    const result = await fetchCNRealtimeQuoteBatch(['603986.SS'], {
      fetchTencent: async () => new Map(),
      fetchSina: async () => new Map(),
      readSnapshot: async () => snapshot('2026-08-25T03:10:00.000Z'),
      now: () => NOW,
    });

    expect(result.source).toBe('unavailable');
    expect(result.quotes.size).toBe(0);
  });
});
