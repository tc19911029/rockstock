import { parseYahooCandlesRaw } from '@/lib/datasource/YahooDataProvider';
import { isZeroVolumeFlatBar } from '@/lib/datasource/candleSanitizers';

describe('Yahoo raw candle normalization', () => {
  it('reverses split-adjusted OHLC before the event and removes a zero-volume suspension bar', () => {
    const at = (date: string) => Math.floor(new Date(`${date}T01:00:00Z`).getTime() / 1000);
    const json = {
      chart: {
        result: [{
          timestamp: [at('2026-07-09'), at('2026-07-10'), at('2026-07-15')],
          indicators: {
            quote: [{
              open: [1904.5454, 1822.7273, 1850],
              high: [1927.2727, 1822.7273, 1885],
              low: [1818.1818, 1822.7273, 1745],
              close: [1822.7273, 1822.7273, 1755],
              volume: [2_259_719, 0, 1_715_434],
            }],
          },
          events: {
            splits: {
              '1784077200': {
                date: Math.floor(new Date('2026-07-15T05:00:00Z').getTime() / 1000),
                numerator: 1100,
                denominator: 1000,
                splitRatio: '1100:1000',
              },
            },
          },
        }],
      },
    };

    expect(parseYahooCandlesRaw(json, '3081.TWO')).toEqual([
      { date: '2026-07-09', open: 2095, high: 2120, low: 2000, close: 2005, volume: 2260 },
      { date: '2026-07-15', open: 1850, high: 1885, low: 1745, close: 1755, volume: 1715 },
    ]);
  });

  it('only classifies zero-volume flat bars as non-trading placeholders', () => {
    expect(isZeroVolumeFlatBar({ open: 100, high: 100, low: 100, close: 100, volume: 0 })).toBe(true);
    expect(isZeroVolumeFlatBar({ open: 100, high: 101, low: 99, close: 100, volume: 0 })).toBe(false);
    expect(isZeroVolumeFlatBar({ open: 100, high: 100, low: 100, close: 100, volume: 1 })).toBe(false);
  });
});
