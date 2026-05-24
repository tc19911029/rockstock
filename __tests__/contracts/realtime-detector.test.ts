/**
 * 合約測試 — 即時分鐘 K 爆量警示 detector
 *
 * 鎖定 4 規則行為 + 通用排除：
 *   1. bars.length < 20 → 不觸發
 *   2. 開盤第一根 (TW 09:00 / CN 09:30) 永遠排除
 *   3. blowoff-bearish: 爆量 + 長黑實體
 *   4. blowoff-bullish: 爆量 + 長紅實體 + 突破前 5 根 high
 *   5. terminal-rally: 連 3 長紅 + 爆量 + MA20 乖離 > 15%
 *   6. ma5-breakdown: 持股 + 5m K + 收盤跌破 5m MA5
 *   7. 每個 signal 帶 caveat='minute-inference'
 *
 * Dispatcher：
 *   8. 同 symbol+rule 在 30 分 debounce 內不重發
 */

import { detect, type DetectorContext } from '@/lib/realtime/blowoffDetector';
import { dispatch, _resetDebounceForTest } from '@/lib/realtime/alertDispatcher';
import type { MinuteBar } from '@/lib/realtime/minuteBarStore';

// 9:00 CST = UTC 01:00 → epoch ms 起算對應 2026-05-12
// 為了測 isFirstBarOfSession 用真實時區，用 fixed date 較穩
const BASE_DATE = '2026-05-12';

function tsAt(hh: number, mm: number): number {
  // 'YYYY-MM-DDTHH:mm+08:00' → epoch ms
  const iso = `${BASE_DATE}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`;
  return new Date(iso).getTime();
}

function bar(
  hh: number, mm: number, open: number, high: number, low: number, close: number, volume: number,
  market: 'TW' | 'CN' = 'TW',
): MinuteBar {
  return {
    symbol: market === 'TW' ? '3661.TW' : '603986.SS',
    market,
    ts: tsAt(hh, mm),
    open, high, low, close, volume,
    tickCount: 1,
  };
}

function makeFlatBars(
  count: number,
  startHh: number, startMm: number,
  price = 100, vol = 100,
  market: 'TW' | 'CN' = 'TW',
): MinuteBar[] {
  const bars: MinuteBar[] = [];
  let mm = startMm, hh = startHh;
  for (let i = 0; i < count; i++) {
    bars.push(bar(hh, mm, price, price, price, price, vol, market));
    mm++;
    if (mm >= 60) { mm = 0; hh++; }
  }
  return bars;
}

const ctxNonHolding: DetectorContext = {
  symbol: '3661.TW', market: 'TW', isHolding: false,
};
const ctxHolding: DetectorContext = {
  symbol: '3661.TW', market: 'TW', isHolding: true,
};

describe('blowoffDetector — 通用排除', () => {
  test('bars.length < 20 不觸發任何 signal', () => {
    const bars = makeFlatBars(15, 9, 1, 100, 100);
    expect(detect(bars, ctxNonHolding, 1)).toEqual([]);
  });

  test('開盤第一根 (TW 09:00) 即使爆量長黑也排除', () => {
    // 先填 19 根 ≥ 20 樣本，最後一根設成 09:00 爆量長黑
    const bars: MinuteBar[] = makeFlatBars(19, 8, 41, 100, 100); // 08:41 ~ 08:59
    // last bar 09:00 爆量長黑（但會被排除）
    bars.push(bar(9, 0, 100, 100, 95, 95, 1000));
    const signals = detect(bars, ctxNonHolding, 1);
    expect(signals).toEqual([]);
  });

  test('CN 09:30 第一根排除', () => {
    const bars: MinuteBar[] = makeFlatBars(19, 9, 11, 100, 100, 'CN'); // 09:11 ~ 09:29
    bars.push(bar(9, 30, 100, 100, 95, 95, 1000, 'CN'));
    const ctxCN: DetectorContext = { symbol: '603986.SS', market: 'CN', isHolding: false };
    expect(detect(bars, ctxCN, 1)).toEqual([]);
  });
});

describe('blowoffDetector — Rule: blowoff-bearish', () => {
  test('爆量 (2x) + 長黑實體 (>60%) 觸發', () => {
    const bars = makeFlatBars(20, 9, 30, 100, 100); // 20 根平淡
    // 最後一根爆量長黑
    bars[bars.length - 1] = bar(9, 49, 100, 101, 94, 95, 1000);
    const signals = detect(bars, ctxNonHolding, 1);
    const bearish = signals.filter(s => s.rule === 'blowoff-bearish');
    expect(bearish.length).toBe(1);
    expect(bearish[0].caveat).toBe('minute-inference');
    expect(bearish[0].meta.volumeMultiplier).toBeGreaterThanOrEqual(2.0);
  });

  test('爆量但 close > open (長紅) 不觸發 bearish', () => {
    const bars = makeFlatBars(20, 9, 30, 100, 100);
    bars[bars.length - 1] = bar(9, 49, 95, 101, 94, 100, 1000); // 長紅
    const signals = detect(bars, ctxNonHolding, 1);
    expect(signals.find(s => s.rule === 'blowoff-bearish')).toBeUndefined();
  });

  test('量未達 2x 不觸發', () => {
    const bars = makeFlatBars(20, 9, 30, 100, 100);
    bars[bars.length - 1] = bar(9, 49, 100, 101, 94, 95, 150); // 1.5x
    const signals = detect(bars, ctxNonHolding, 1);
    expect(signals.find(s => s.rule === 'blowoff-bearish')).toBeUndefined();
  });

  test('實體比 < 60% 不觸發', () => {
    const bars = makeFlatBars(20, 9, 30, 100, 100);
    // open=100 close=99 → body=1，high=110 low=90 → range=20，body/range=0.05
    bars[bars.length - 1] = bar(9, 49, 100, 110, 90, 99, 1000);
    const signals = detect(bars, ctxNonHolding, 1);
    expect(signals.find(s => s.rule === 'blowoff-bearish')).toBeUndefined();
  });
});

describe('blowoffDetector — Rule: blowoff-bullish', () => {
  test('爆量 + 長紅 + 突破前 5 根 high → 觸發', () => {
    const bars = makeFlatBars(20, 9, 30, 100, 100); // 高點都是 100
    bars[bars.length - 1] = bar(9, 49, 100, 106, 99, 105, 1000); // 長紅 + 突破
    const signals = detect(bars, ctxNonHolding, 1);
    const bullish = signals.filter(s => s.rule === 'blowoff-bullish');
    expect(bullish.length).toBe(1);
  });

  test('爆量 + 長紅但未突破前 5 根 high → 不觸發', () => {
    const bars = makeFlatBars(20, 9, 30, 100, 100);
    bars[bars.length - 1] = bar(9, 49, 95, 99, 94, 99, 1000); // close 99 < prev high 100
    const signals = detect(bars, ctxNonHolding, 1);
    expect(signals.find(s => s.rule === 'blowoff-bullish')).toBeUndefined();
  });
});

describe('blowoffDetector — Rule: terminal-rally', () => {
  test('連 3 長紅 + 第 3 根爆量 + MA20 乖離 > 15% 觸發', () => {
    // 前 17 根低點累積 MA20 約 80
    const bars: MinuteBar[] = [];
    let mm = 30, hh = 9;
    for (let i = 0; i < 17; i++) {
      bars.push(bar(hh, mm, 80, 80, 80, 80, 100));
      mm++; if (mm >= 60) { mm = 0; hh++; }
    }
    // 連 3 長紅 + 第 3 根爆量 + close 接近 100（MA20 ≈ 80×17/20 + (90+95+100)/20 ≈ 82.25）
    // 100 / 82.25 - 1 ≈ 21.6%（> 15%）
    bars.push(bar(hh, mm++, 85, 90, 85, 90, 200));      // 長紅 #1
    bars.push(bar(hh, mm++, 90, 95, 90, 95, 200));      // 長紅 #2
    bars.push(bar(hh, mm++, 95, 100, 95, 100, 1000));   // 長紅 #3 + 爆量
    const signals = detect(bars, ctxNonHolding, 1);
    const terminal = signals.filter(s => s.rule === 'terminal-rally');
    expect(terminal.length).toBe(1);
  });

  test('連 3 紅但乖離率不足 → 不觸發', () => {
    const bars = makeFlatBars(17, 9, 30, 98, 100); // 已經接近最後一根，乖離小
    bars.push(bar(9, 47, 98, 99, 98, 99, 200));
    bars.push(bar(9, 48, 99, 100, 99, 100, 200));
    bars.push(bar(9, 49, 100, 101, 100, 101, 1000));
    const signals = detect(bars, ctxNonHolding, 1);
    expect(signals.find(s => s.rule === 'terminal-rally')).toBeUndefined();
  });
});

describe('blowoffDetector — Rule: ma5-breakdown', () => {
  test('持股 + 5m K 收盤跌破 5m MA5 觸發', () => {
    const bars = makeFlatBars(20, 9, 0, 100, 100);
    // 最後一根 close 跌破 MA5（前 4 根 = 100，平均 = 100，當前 close = 95 < 100）
    bars[bars.length - 1] = bar(10, 0, 96, 96, 94, 95, 100);
    const signals = detect(bars, ctxHolding, 5);
    expect(signals.find(s => s.rule === 'ma5-breakdown')).toBeDefined();
  });

  test('非持股 不觸發 ma5-breakdown', () => {
    const bars = makeFlatBars(20, 9, 0, 100, 100);
    bars[bars.length - 1] = bar(10, 0, 96, 96, 94, 95, 100);
    const signals = detect(bars, ctxNonHolding, 5);
    expect(signals.find(s => s.rule === 'ma5-breakdown')).toBeUndefined();
  });

  test('tfMin=1 不觸發 ma5-breakdown（只在 5m 跑）', () => {
    const bars = makeFlatBars(20, 9, 0, 100, 100);
    bars[bars.length - 1] = bar(9, 30, 96, 96, 94, 95, 100);
    const signals = detect(bars, ctxHolding, 1);
    expect(signals.find(s => s.rule === 'ma5-breakdown')).toBeUndefined();
  });
});

describe('alertDispatcher — debounce', () => {
  beforeEach(() => {
    _resetDebounceForTest();
    // ntfy disabled (no NTFY_ENABLED env) — 不會真發推播
  });

  test('同 symbol+rule 第二次 dispatch 在 30 分內被 debounced', async () => {
    const sig = {
      rule: 'blowoff-bearish' as const,
      symbol: '3661.TW',
      market: 'TW' as const,
      ts: tsAt(10, 0),
      tfMin: 1 as const,
      meta: {
        open: 100, high: 101, low: 94, close: 95, volume: 1000,
        volumeMultiplier: 2.3, pctChange: -5, bodyRatio: 0.7, ma20Deviation: 0,
      },
      caveat: 'minute-inference' as const,
      isHolding: false,
    };
    const r1 = await dispatch([sig], { logToDisk: false });
    const r2 = await dispatch([sig], { logToDisk: false });
    expect(r1.fired).toBe(1);
    expect(r2.fired).toBe(0);
    expect(r2.debounced).toBe(1);
  });

  test('不同 rule 不互相 debounce', async () => {
    const base = {
      symbol: '3661.TW', market: 'TW' as const, ts: tsAt(10, 0), tfMin: 1 as const,
      meta: {
        open: 100, high: 101, low: 94, close: 95, volume: 1000,
        volumeMultiplier: 2.3, pctChange: -5, bodyRatio: 0.7, ma20Deviation: 0,
      },
      caveat: 'minute-inference' as const, isHolding: false,
    };
    const r = await dispatch([
      { ...base, rule: 'blowoff-bearish' as const },
      { ...base, rule: 'terminal-rally' as const },
    ], { logToDisk: false });
    expect(r.fired).toBe(2);
  });
});
