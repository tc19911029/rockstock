import { detectLetterNStructure } from '@/lib/analysis/v12LetterN';
import type { CandleWithIndicators } from '@/types';

function candle(index: number, close: number, high: number, low: number): CandleWithIndicators {
  return {
    date: `d${index}`,
    open: close,
    high,
    low,
    close,
    volume: 1_000,
    ma5: 100,
  } as CandleWithIndicators;
}

describe('N 字底 regression', () => {
  it('保留目標投射使用的前低腳位，讓 A-B 回檔與目標都可核對', () => {
    const candles: CandleWithIndicators[] = [];
    for (let i = 0; i <= 12; i++) candles.push(candle(i, 95, 97, i === 10 ? 80 : 93));
    for (let i = 13; i <= 22; i++) candles.push(candle(i, 105, i === 20 ? 120 : 108, 103));
    for (let i = 23; i <= 28; i++) candles.push(candle(i, 95, 97, i === 26 ? 100 : 101));
    for (let i = 29; i <= 39; i++) candles.push(candle(i, i === 39 ? 124 : 105, i === 39 ? 125 : 108, 103));

    const result = detectLetterNStructure(candles, candles.length - 1);

    expect(result.patternType).toBe('n-shape');
    expect(result.pivots?.map(pivot => [pivot.index, pivot.price])).toEqual([
      [20, 120],
      [26, 100],
      [10, 80],
    ]);
    expect(result.patternTargetPrice).toBe(140);
  });
});
