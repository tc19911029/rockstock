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
