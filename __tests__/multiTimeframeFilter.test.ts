import {
  clearAggregationCache,
  evaluateMultiTimeframe,
  evaluateWeeklyProtectionGate,
  isHigherTimeframePeriodClosed,
} from '@/lib/analysis/multiTimeframeFilter';
import { BASE_THRESHOLDS } from '@/lib/strategy/StrategyConfig';

describe('multi-timeframe protection gate', () => {
  test('honors the configured 0-4 minimum score', () => {
    const checks = { trend: true, maDirection: true, position: true, resistance: false };
    expect(evaluateWeeklyProtectionGate(checks, 3)).toEqual({ score: 3, minScore: 3, pass: true });
    expect(evaluateWeeklyProtectionGate(checks, 4)).toEqual({ score: 3, minScore: 4, pass: false });
  });

  test('weekly direction is mandatory even when the other three protections pass', () => {
    const checks = { trend: false, maDirection: true, position: true, resistance: true };
    expect(evaluateWeeklyProtectionGate(checks, 3).pass).toBe(false);
  });

  test('clamps invalid thresholds to the documented range', () => {
    const checks = { trend: true, maDirection: true, position: true, resistance: true };
    expect(evaluateWeeklyProtectionGate(checks, 99).minScore).toBe(4);
    expect(evaluateWeeklyProtectionGate(checks, -2).minScore).toBe(0);
  });

  test('isolates aggregation cache by candle array instead of date/count', () => {
    const dates: string[] = [];
    let cursor = new Date('2024-01-01T12:00:00Z');
    while (dates.length < 260) {
      if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
        dates.push(cursor.toISOString().slice(0, 10));
      }
      cursor = new Date(cursor.getTime() + 86_400_000);
    }
    const makeCandles = (boostLastWeek: boolean) => dates.map((date, index) => {
      const close = 100 + Math.sin(index / 8) * 8 + index * 0.05;
      return {
        date, open: close - 1, high: close + 2, low: close - 2, close,
        volume: boostLastWeek && index >= 255 ? 1_000 : 100,
      };
    });

    clearAggregationCache();
    const boosted = evaluateMultiTimeframe(makeCandles(true), BASE_THRESHOLDS);
    const normal = evaluateMultiTimeframe(makeCandles(false), BASE_THRESHOLDS);

    expect(boosted.weeklyChecks.volume).toBe(true);
    expect(normal.weeklyChecks.volume).toBe(false);
    expect(normal.weeklyProtectionChecks.resistance).toBe(false);
  });

  test('uses trading calendar and market close instead of Friday/day-25 heuristics', () => {
    expect(isHigherTimeframePeriodClosed(
      '2026-08-21', 'weekly', 'TW', new Date('2026-08-21T04:00:00Z'),
    )).toBe(false); // 週五 12:00，仍是半根 K
    expect(isHigherTimeframePeriodClosed(
      '2026-06-18', 'weekly', 'TW', new Date('2026-06-18T07:00:00Z'),
    )).toBe(true); // 週五端午休市，週四收盤即為完整週
    expect(isHigherTimeframePeriodClosed(
      '2026-08-25', 'monthly', 'TW', new Date('2026-08-25T08:00:00Z'),
    )).toBe(false);
  });
});
