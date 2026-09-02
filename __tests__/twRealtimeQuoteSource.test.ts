import type { IntradaySnapshot } from '@/lib/datasource/IntradayCache';
import {
  _resetTWRealtimeQuoteStateForTest,
  fetchTWRealtimeQuoteBatch,
} from '@/lib/realtime/TWRealtimeQuoteSource';

const NOW = new Date('2026-09-02T03:30:00.000Z');

function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    c: '2330', d: '20260902', t: '11:30:00', tlong: String(NOW.getTime()),
    z: '100', v: '1,234', h: '102', y: '98', ...overrides,
  };
}

function snapshot(updatedAt = '2026-09-02T03:29:30.000Z'): IntradaySnapshot {
  return {
    market: 'TW', date: '2026-09-02', updatedAt, count: 1,
    quotes: [{
      symbol: '2330', name: '台積電', open: 98, high: 102, low: 97,
      close: 99, volume: 1200, prevClose: 98, changePercent: 1.02,
      priceKind: 'last_actual', lastActualPrice: 99,
      lastActualAt: '2026-09-02T03:29:00.000Z',
    }],
  };
}

describe('台股 realtime-scan 目標池 MIS 報價', () => {
  beforeEach(() => _resetTWRealtimeQuoteStateForTest());

  test('單一批次同查 tse/otc，解析實際成交與累積張數', async () => {
    const fetchMis = jest.fn(async (_url: string) => ({ msgArray: [row()] }));
    const result = await fetchTWRealtimeQuoteBatch(['2330.TW'], {
      fetchMis,
      readSnapshot: async () => null,
      now: () => NOW,
    });

    expect(fetchMis.mock.calls[0][0]).toContain('tse_2330.tw|otc_2330.tw');
    expect(result.source).toBe('mis-targeted');
    expect(result.quotes.get('2330')).toMatchObject({ close: 100, volume: 1234, isActualTrade: true });
  });

  test('下一輪 z 缺失時沿用最後確認成交價，但使用新的累積量', async () => {
    const responses = [row(), row({ z: '-', v: '1,260', t: '11:30:10' })];
    const dependencies = {
      fetchMis: async () => ({ msgArray: [responses.shift()!] }),
      readSnapshot: async () => null,
      now: () => NOW,
    };
    await fetchTWRealtimeQuoteBatch(['2330.TW'], dependencies);
    const second = await fetchTWRealtimeQuoteBatch(['2330.TW'], dependencies);

    expect(second.quotes.get('2330')).toMatchObject({ close: 100, volume: 1260, isActualTrade: false });
  });

  test('冷啟動 z 缺失時只接受新鮮 L2 的最後實際成交價', async () => {
    const result = await fetchTWRealtimeQuoteBatch(['2330.TW'], {
      fetchMis: async () => ({ msgArray: [row({ z: '-' })] }),
      readSnapshot: async () => snapshot(),
      now: () => NOW,
    });

    expect(result.source).toBe('mis-targeted+l2');
    expect(result.quotes.get('2330')?.close).toBe(99);
  });

  test('拒絕過舊 L2 與委買賣推估價', async () => {
    const result = await fetchTWRealtimeQuoteBatch(['2330.TW'], {
      fetchMis: async () => ({ msgArray: [row({ z: '-', b: '99.0000', a: '100.0000' })] }),
      readSnapshot: async () => snapshot('2026-09-02T03:10:00.000Z'),
      now: () => NOW,
    });

    expect(result.quotes.size).toBe(0);
  });

  test('暖狀態 MIS 整批失敗時才補讀新鮮 L2，不讓保命報價中斷', async () => {
    let fail = false;
    const readSnapshot = jest.fn(async () => snapshot());
    const dependencies = {
      fetchMis: async () => {
        if (fail) throw new Error('timeout');
        return { msgArray: [row()] };
      },
      readSnapshot,
      now: () => NOW,
    };
    await fetchTWRealtimeQuoteBatch(['2330.TW'], dependencies);
    readSnapshot.mockClear();
    fail = true;

    const fallback = await fetchTWRealtimeQuoteBatch(['2330.TW'], dependencies);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(fallback.source).toBe('l2-snapshot');
    expect(fallback.quotes.get('2330')?.close).toBe(99);
  });
});
