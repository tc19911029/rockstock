import { detectLetterNStructure } from '@/lib/analysis/v12LetterN';
import type { CandleWithIndicators } from '@/types';

function candle(index: number, close: number, high: number, low: number, ma5 = 100): CandleWithIndicators {
  return {
    date: `d${index}`,
    open: close,
    high,
    low,
    close,
    volume: 1_000,
    ma5,
  } as CandleWithIndicators;
}

describe('N 字底 regression', () => {
  function nShapeCandles(latestClose: number): CandleWithIndicators[] {
    const candles: CandleWithIndicators[] = [];
    const ma5 = 105;
    for (let i = 0; i <= 12; i++) candles.push(candle(i, 95, 97, i === 10 ? 80 : 93, ma5));
    for (let i = 13; i <= 22; i++) candles.push(candle(i, 110, i === 20 ? 120 : 113, 108, ma5));
    for (let i = 23; i <= 28; i++) candles.push(candle(i, 102, 104, i === 26 ? 100 : 101, ma5));
    for (let i = 29; i <= 35; i++) {
      candles.push(candle(i, i === 35 ? latestClose : 110, i === 35 ? latestClose + 1 : 113, 108, ma5));
    }
    return candles;
  }

  it('保留目標投射使用的前低腳位，讓 A-B 回檔與目標都可核對', () => {
    const candles = nShapeCandles(124);

    const result = detectLetterNStructure(candles, candles.length - 1);

    expect(result.patternType).toBe('n-shape');
    expect(result.pivots?.map(pivot => [pivot.index, pivot.price])).toEqual([
      [20, 120],
      [26, 100],
      [10, 80],
    ]);
    expect(result.patternTargetPrice).toBe(140);
  });

  it('尚未越過 A 前高、但距頸線 10% 內時顯示形成中的 N 字', () => {
    const candles = nShapeCandles(112);
    const result = detectLetterNStructure(candles, candles.length - 1, 90);

    expect(result.patternType).toBe('n-shape');
    expect(result.necklinePrice).toBe(120);
    expect(result.breakoutThreshold).toBeCloseTo(123.6);
    expect(result.displayReady).toBe(true);
    expect(result.triggered).toBe(false);
  });
});
