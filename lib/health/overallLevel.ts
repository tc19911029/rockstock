import { MIN_VERIFY_UNIVERSE } from '@/lib/scanner/coverageGuard';

export interface OverallHealthSignal {
  market: 'TW' | 'CN';
  ok: boolean;
  health: string;
  expectedDate: string;
  reportDate: string | null;
  coverageRate: number | null;
  totalStocks: number | null;
  stocksStale: number | null;
  l2AlertLevel: string;
  l4Status: string;
  l4LastDate: string | null;
  limitUpConsistencyLevel: string;
  strategyStatus: string;
}

export function deriveOverallLevel(items: OverallHealthSignal[]): 'green' | 'yellow' | 'red' {
  let red = 0;
  let yellow = 0;
  for (const it of items) {
    if (!it.ok) { red++; continue; }
    if (it.health === 'critical' || it.health === 'no_report') red++;
    else if (it.health === 'warning') yellow++;
    if (it.reportDate !== it.expectedDate) red++;
    if ((it.totalStocks ?? 0) < MIN_VERIFY_UNIVERSE[it.market]) red++;
    if (it.coverageRate == null || it.coverageRate < 0.90) red++;
    else if (it.coverageRate < 0.97) yellow++;
    if ((it.stocksStale ?? 0) > 200) red++;
    else if ((it.stocksStale ?? 0) > 50) yellow++;
    if (it.l2AlertLevel === 'critical') red++;
    else if (it.l2AlertLevel === 'warning') yellow++;
    if (it.l4Status !== 'fresh' || it.l4LastDate !== it.expectedDate) red++;
    if (it.strategyStatus !== 'ready') red++;
    if (it.limitUpConsistencyLevel === 'critical') red++;
    else if (it.limitUpConsistencyLevel === 'warning') yellow++;
  }
  if (red > 0) return 'red';
  if (yellow > 0) return 'yellow';
  return 'green';
}
