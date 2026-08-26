import type { Candle } from '@/types';
import { isolateSanseCandles } from '@/lib/cn-sanse/chartCandles';
import { canonicalSanseInstrument, dedupeSanseWatch, sanseAlertKey } from '@/lib/cn-sanse/alertIdentity';
import { clearCache, getFromCache, updateCache } from '@/lib/datasource/L1CandleCache';

describe('三色盤中 K 棒完整性', () => {
  it('複製共享 L1 陣列，盤中 append 不會回寫 cache', () => {
    const cached: Candle[] = [
      { date: '2026-08-20', open: 2765, high: 2830, low: 2635, close: 2780, volume: 4519 },
    ];
    const requestCandles = isolateSanseCandles(cached);
    requestCandles.push({ date: '2026-08-21', open: 2845, high: 2920, low: 2760, close: 2920, volume: 4752 });

    expect(cached).toHaveLength(1);
    expect(cached.at(-1)?.date).toBe('2026-08-20');
    expect(requestCandles).toHaveLength(2);
  });

  it('同日期舊污染只保留最後一根並恢復日期順序', () => {
    const isolated = isolateSanseCandles([
      { date: '2026-08-21', open: 2910, high: 2910, low: 2910, close: 2910, volume: 1 },
      { date: '2026-08-20', open: 2765, high: 2830, low: 2635, close: 2780, volume: 4519 },
      { date: '2026-08-21', open: 2845, high: 2920, low: 2760, close: 2920, volume: 4752 },
    ]);

    expect(isolated.map((c) => c.date)).toEqual(['2026-08-20', '2026-08-21']);
    expect(isolated.at(-1)?.open).toBe(2845);
  });
});

describe('L1 記憶體快取隔離', () => {
  afterEach(() => clearCache());

  it('caller 修改 array、metadata 或 candle object 都不會污染下一個 reader', () => {
    const source = {
      symbol: '3081.TWO',
      lastDate: '2026-08-20',
      updatedAt: '2026-08-20T08:00:00.000Z',
      candles: [
        { date: '2026-08-20', open: 2765, high: 2830, low: 2635, close: 2780, volume: 4519 },
      ],
    };
    updateCache(source.symbol, 'TW', source);

    // updateCache 也不能保留 caller 的 reference。
    source.candles.push({ date: '2026-08-21', open: 1, high: 1, low: 1, close: 1, volume: 1 });
    const first = getFromCache('3081.TWO', 'TW')!;
    first.lastDate = '2099-01-01';
    first.candles.push({ date: '2099-01-01', open: 1, high: 1, low: 1, close: 1, volume: 1 });
    try { first.candles[0].close = 999; } catch { /* frozen cache candle：預期可能 throw */ }

    const second = getFromCache('3081.TWO', 'TW')!;
    expect(second.lastDate).toBe('2026-08-20');
    expect(second.candles).toHaveLength(1);
    expect(second.candles[0].close).toBe(2780);
    expect(Object.isFrozen(second.candles[0])).toBe(true);
  });

  it('磁碟版本改變時立即淘汰跨 process 留下的舊 cache', () => {
    const source = {
      symbol: '3081.TWO',
      lastDate: '2026-08-25',
      updatedAt: '2026-08-25T08:00:00.000Z',
      candles: [
        { date: '2026-08-25', open: 2860, high: 2995, low: 2840, close: 2960, volume: 6075 },
      ],
    };
    updateCache(source.symbol, 'TW', source, 'old-version');

    expect(getFromCache(source.symbol, 'TW', 'old-version')?.lastDate).toBe('2026-08-25');
    expect(getFromCache(source.symbol, 'TW', 'new-version')).toBeNull();
  });
});

describe('三色推播標的去重', () => {
  it('3081.TW 與 3081.TWO 視為同一台股，但陸股保留交易所', () => {
    expect(canonicalSanseInstrument('3081.TW')).toBe('TW:3081');
    expect(canonicalSanseInstrument('3081.TWO')).toBe('TW:3081');
    expect(canonicalSanseInstrument('000001.SS')).not.toBe(canonicalSanseInstrument('000001.SZ'));
  });

  it('合併跨 profile 的同股別名，且一般/底反 key 可分開並能跨重啟還原', () => {
    const watch = dedupeSanseWatch([
      { symbol: '3081.TW', name: '聯亞' },
      { symbol: '3081.TWO', name: '聯亞' },
      { symbol: '2330.TW', name: '台積電' },
    ]);
    expect(watch.map((x) => x.symbol)).toEqual(['3081.TW', '2330.TW']);
    expect(sanseAlertKey('2026-08-21', '3081.TW', 'sell')).toBe(
      sanseAlertKey('2026-08-21', '3081.TWO', 'sell'),
    );
    expect(sanseAlertKey('2026-08-21', '3081.TW', 'buy', true)).not.toBe(
      sanseAlertKey('2026-08-21', '3081.TW', 'buy', false),
    );
  });
});
