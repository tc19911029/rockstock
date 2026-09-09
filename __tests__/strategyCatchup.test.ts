import { strategyCatchupDates, assertSanSeCatchupResult } from '@/lib/scanner/strategyCatchup';
import type { SanSeScanResult } from '@/lib/cn-sanse/scan';

const scan = (overrides: Partial<SanSeScanResult> = {}) => ({
  lastDate: '2026-09-08', evaluated: 495, staleSkipped: 2, turnoverFiltered: 1400, ...overrides,
} as SanSeScanResult);

test('catch-up includes dates absent from a stale index, and skips weekends/holidays', () => {
  expect(strategyCatchupDates('TW', '2026-09-08', 3)).toEqual(['2026-09-04', '2026-09-07', '2026-09-08']);
  expect(strategyCatchupDates('TW', '2026-09-28', 2)).toEqual(['2026-09-23', '2026-09-24']);
  expect(() => strategyCatchupDates('TW', '2026-02-30', 2)).toThrow();
});

test('stale index, zero evaluation and degenerate results fail instead of claiming success', () => {
  expect(() => assertSanSeCatchupResult('2026-09-08', scan())).not.toThrow();
  expect(() => assertSanSeCatchupResult('2026-09-08', scan({ lastDate: '2026-09-04' }))).toThrow('index input is stale');
  expect(() => assertSanSeCatchupResult('2026-09-08', scan({ evaluated: 0 }))).toThrow('no stocks');
  expect(() => assertSanSeCatchupResult('2026-09-08', scan({ evaluated: 1, turnoverFiltered: 0, staleSkipped: 1999 }))).toThrow('stale-dominated');
});
