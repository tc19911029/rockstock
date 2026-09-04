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
  l1l2ConsistencyLevel: string;
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
    // 盤中掃描可能已經有今天的 L4，而盤後基準仍是前一交易日；較新的 fresh
    // 資料不應因日期「不相等」被誤判紅燈。只有缺少或落後 expectedDate 才算異常。
    if (it.l4Status !== 'fresh' || !it.l4LastDate || it.l4LastDate < it.expectedDate) red++;
    if (it.strategyStatus !== 'ready') red++;
    if (it.limitUpConsistencyLevel === 'critical') red++;
    else if (it.limitUpConsistencyLevel === 'warning') yellow++;
    if (it.l1l2ConsistencyLevel === 'critical') red++;
    else if (it.l1l2ConsistencyLevel === 'warning' || it.l1l2ConsistencyLevel === 'unavailable') yellow++;
  }
  if (red > 0) return 'red';
  if (yellow > 0) return 'yellow';
  return 'green';
}
