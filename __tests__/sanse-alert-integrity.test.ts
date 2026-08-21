import type { Candle } from '@/types';
import { isolateSanseCandles } from '@/lib/cn-sanse/chartCandles';
import { canonicalSanseInstrument, dedupeSanseWatch, sanseAlertKey } from '@/lib/cn-sanse/alertIdentity';

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
