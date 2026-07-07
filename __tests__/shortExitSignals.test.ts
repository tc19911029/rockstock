// 做空出場訊號 — 課程 CH1-6 第4點回歸測試：
// 「突破前高壓力＝頭頭高＝空頭趨勢改變 → 不宜再繼續做空」→ 首次收盤過前反彈高點要報回補。
import { detectShortExitSignals } from '@/lib/analysis/shortAnalysis';
import type { CandleWithIndicators } from '@/types';

function bar(date: string, close: number, high?: number, low?: number): CandleWithIndicators {
  return {
    date, open: close, close,
    high: high ?? close + 0.3,
    low: low ?? close - 0.3,
    volume: 1000,
  } as unknown as CandleWithIndicators;
}

describe('detectShortExitSignals — 過前高回補（頭頭高）', () => {
  // 空頭下跌 → 反彈出一個局部高點（前高）→ 再跌 → 今天收盤突破那個前高
  function mkSeries(breakClose: number): CandleWithIndicators[] {
    return [
      bar('d01', 100), bar('d02', 98), bar('d03', 96), bar('d04', 94), bar('d05', 92),
      bar('d06', 90),
      bar('d07', 93, 93.5),   // 反彈局部高點（swing high 93.5）
      bar('d08', 91),
      bar('d09', 89), bar('d10', 88), bar('d11', 87.5),
      bar('d12', breakClose), // 今天
    ];
  }

  test('首次收盤突破前反彈高點 → 報回補', () => {
    const candles = mkSeries(94); // 94 > 93.5 突破
    const signals = detectShortExitSignals(candles, candles.length - 1);
    expect(signals.some((s) => s.type === 'SHORT_BREAK_PREV_HIGH')).toBe(true);
  });

  test('沒過前高 → 不報', () => {
    const candles = mkSeries(89); // 89 < 93.5
    const signals = detectShortExitSignals(candles, candles.length - 1);
    expect(signals.some((s) => s.type === 'SHORT_BREAK_PREV_HIGH')).toBe(false);
  });

  test('事件型：突破隔天不重複報', () => {
    const candles = [...mkSeries(94), bar('d13', 95)];
    const signals = detectShortExitSignals(candles, candles.length - 1);
    expect(signals.some((s) => s.type === 'SHORT_BREAK_PREV_HIGH')).toBe(false);
  });
});

// 逐字-5：長線空單「收盤突破月線 MA20 → 回補」
describe('detectShortExitSignals — 突破月線回補（長線空單）', () => {
  function barMa(close: number, ma20: number, ma5?: number): CandleWithIndicators {
    return { date: 'd', open: close, close, high: close + 0.2, low: close - 0.2, volume: 1000, ma20, ma5: ma5 ?? close } as unknown as CandleWithIndicators;
  }
  test('昨收在月線下、今收突破月線 → 報 MA20 回補', () => {
    const base = Array.from({ length: 10 }, () => barMa(90, 100));
    const candles = [...base, barMa(99, 100), barMa(101, 100)]; // 昨99<100、今101>100
    const signals = detectShortExitSignals(candles, candles.length - 1);
    expect(signals.some((s) => s.type === 'SHORT_BREAK_ABOVE_MA20')).toBe(true);
  });
  test('持續在月線下 → 不報', () => {
    const candles = Array.from({ length: 12 }, () => barMa(95, 100));
    const signals = detectShortExitSignals(candles, candles.length - 1);
    expect(signals.some((s) => s.type === 'SHORT_BREAK_ABOVE_MA20')).toBe(false);
  });
});

// 逐字-10a：空單連跌3天>8% + 今日紅K → 先獲利一趟
describe('detectShortExitSignals — 連跌3天逾8%先獲利一趟', () => {
  function ohlc(open: number, close: number): CandleWithIndicators {
    return { date: 'd', open, close, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, volume: 1000, ma5: 200, ma20: 200 } as unknown as CandleWithIndicators;
  }
  test('連跌3天累跌>8% + 今日紅K → 報先獲利一趟', () => {
    const base = Array.from({ length: 5 }, () => ohlc(100, 100));
    // 3 天連跌：100→97→94→91（base3=100, today 收紅 92>開91.5，累跌 (100-92)/100=8%... 用更深）
    const candles = [...base, ohlc(100, 100), ohlc(100, 96), ohlc(96, 93), ohlc(93, 90), ohlc(90.5, 92)];
    const signals = detectShortExitSignals(candles, candles.length - 1);
    expect(signals.some(s => s.type === 'SHORT_PLUNGE_3D_TAKE_PROFIT')).toBe(true);
  });
  test('連跌3天但今日續黑（沒紅K上來）→ 不報', () => {
    const base = Array.from({ length: 5 }, () => ohlc(100, 100));
    const candles = [...base, ohlc(100, 100), ohlc(100, 96), ohlc(96, 93), ohlc(93, 90), ohlc(90, 88)];
    const signals = detectShortExitSignals(candles, candles.length - 1);
    expect(signals.some(s => s.type === 'SHORT_PLUNGE_3D_TAKE_PROFIT')).toBe(false);
  });
});

// 逐字-4b：進場黑K次日並排紅K（左長黑右長紅）＝假跌破警示
describe('detectShortExitSignals — 並排紅K假跌破', () => {
  function ohlc(open: number, close: number): CandleWithIndicators {
    return { date: 'd', open, close, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, volume: 1000, ma5: 100, ma20: 100 } as unknown as CandleWithIndicators;
  }
  test('昨長黑、今長紅並排實體 → 報假跌破', () => {
    const base = Array.from({ length: 6 }, () => ohlc(100, 100));
    // 昨長黑 100→96（-4%），今長紅 96.5→99（開落在昨實體內、收≥昨收）
    const candles = [...base, ohlc(100, 96), ohlc(96.5, 99)];
    const signals = detectShortExitSignals(candles, candles.length - 1);
    expect(signals.some((s) => s.type === 'SHORT_PARALLEL_RED_FALSE_BREAK')).toBe(true);
  });
});
