import {
  _resetForTest,
  getBars,
  ingestHistoricalBars,
  pushTick,
  type MinuteBar,
} from '@/lib/realtime/minuteBarStore';

const SYMBOL = '2330.TW';

function at(hh: number, mm: number): number {
  return new Date(`2026-09-02T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`).getTime();
}

function historicalBars(): MinuteBar[] {
  return Array.from({ length: 20 }, (_, index) => ({
    symbol: SYMBOL,
    market: 'TW' as const,
    ts: at(9, index),
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 100,
    tickCount: 1,
  }));
}

describe('minuteBarStore 累積量基準', () => {
  beforeEach(() => _resetForTest());

  test('backfill 後用全部分鐘量總和作 baseline，不把整日量灌入下一根', () => {
    ingestHistoricalBars(SYMBOL, 'TW', historicalBars());
    pushTick(SYMBOL, 'TW', { price: 99, cumulativeVolume: 2050, ts: at(9, 20) });

    const latest = getBars(SYMBOL).at(-1);
    expect(latest?.volume).toBe(50);
  });

  test('live tick 先到、backfill 後到時不倒退累積量 baseline', () => {
    pushTick(SYMBOL, 'TW', { price: 100, cumulativeVolume: 2050, ts: at(9, 20) });
    expect(getBars(SYMBOL).at(-1)?.volume).toBe(0);

    ingestHistoricalBars(SYMBOL, 'TW', historicalBars());
    pushTick(SYMBOL, 'TW', { price: 99, cumulativeVolume: 2100, ts: at(9, 21) });

    expect(getBars(SYMBOL).at(-1)?.volume).toBe(50);
  });

  test('完全冷啟動第一筆只建立 baseline，不製造假巨量 K', () => {
    pushTick(SYMBOL, 'TW', { price: 100, cumulativeVolume: 18_000, ts: at(10, 0) });
    pushTick(SYMBOL, 'TW', { price: 99, cumulativeVolume: 18_030, ts: at(10, 1) });

    const bars = getBars(SYMBOL);
    expect(bars[0].volume).toBe(0);
    expect(bars[1].volume).toBe(30);
  });
});
