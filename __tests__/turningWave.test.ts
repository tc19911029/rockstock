// 轉折波 — 課程 CH1-1 判準回歸測試：
// 「收盤價跟均線一模一樣不算突破/跌破，要等明天再確認」→ 平盤日不可產生轉折點。
import { computeTurningWave } from '@/lib/analysis/turningWave';
import type { CandleWithIndicators } from '@/types';

function bar(date: string, close: number, ma5: number | null, high?: number, low?: number): CandleWithIndicators {
  return {
    date, open: close, close,
    high: high ?? close + 0.2,
    low: low ?? close - 0.2,
    volume: 1000,
    ma5,
  } as unknown as CandleWithIndicators;
}

describe('computeTurningWave — CH1-1 平盤不算跌破', () => {
  test('收盤 == MA5 沿用前一段狀態，不提前出轉折點', () => {
    const candles = [
      bar('2026-01-01', 10.0, null),
      bar('2026-01-02', 10.2, null),
      bar('2026-01-03', 10.0, 9.0),   // 站上（above）
      bar('2026-01-04', 10.5, 9.5),   // above
      bar('2026-01-05', 9.8, 9.8),    // 平盤（close==ma5）→ 課程：不算跌破
      bar('2026-01-06', 10.6, 10.0),  // above
      bar('2026-01-07', 9.0, 9.9),    // 真跌破 → 這裡才出高點轉折
    ];
    const w = computeTurningWave(candles, candles.length - 1, 5);
    // 舊版 bug：01-05 平盤被當跌破 → 會多出 高/低/高 3 個點；課程判準只有 01-07 一次跌破 → 1 個高點
    expect(w.points).toHaveLength(1);
    expect(w.points[0].type).toBe('high');
  });

  test('首根就平盤 → 等下一根才定位，不崩潰', () => {
    const candles = [
      bar('2026-01-01', 10.0, 10.0),  // 平盤且尚未初始化
      bar('2026-01-02', 10.5, 10.0),  // above
      bar('2026-01-03', 9.0, 10.0),   // 跌破 → 高點
    ];
    const w = computeTurningWave(candles, candles.length - 1, 5);
    expect(w.points).toHaveLength(1);
    expect(w.points[0].type).toBe('high');
  });
});
