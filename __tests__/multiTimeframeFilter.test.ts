import { evaluateWeeklyProtectionGate } from '@/lib/analysis/multiTimeframeFilter';

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
});
