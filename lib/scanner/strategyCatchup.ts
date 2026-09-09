import { isTradingDay } from '@/lib/utils/tradingDay';
import { degenerateScanReason } from '@/lib/cn-sanse/scanGuard';
import type { SanSeScanResult } from '@/lib/cn-sanse/scan';

/** Use the exchange calendar, never the input file whose missing days we are repairing. */
export function strategyCatchupDates(market: 'TW' | 'CN', endDate: string, count: number): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !Number.isInteger(count) || count < 1 || count > 366) {
    throw new Error('Invalid catch-up date/count');
  }
  const cursor = new Date(`${endDate}T12:00:00Z`);
  if (!Number.isFinite(cursor.getTime()) || cursor.toISOString().slice(0, 10) !== endDate) {
    throw new Error('Invalid catch-up date');
  }
  const dates: string[] = [];
  while (dates.length < count) {
    const date = cursor.toISOString().slice(0, 10);
    if (isTradingDay(date, market)) dates.push(date);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return dates.reverse();
}

export function assertSanSeCatchupResult(date: string, result: SanSeScanResult): void {
  if (result.lastDate !== date) throw new Error(`Expected ${date}, got ${result.lastDate}; index input is stale`);
  if (result.evaluated <= 0) throw new Error(`${date}: no stocks evaluated`);
  const reason = degenerateScanReason(result);
  if (reason) throw new Error(`${date}: ${reason}`);
}
