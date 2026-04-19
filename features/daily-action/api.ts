import type { DailyActionList, Holding } from '@/lib/portfolio/types';
import type { MarketId } from '@/lib/scanner/types';

export interface FetchDailyActionInput {
  market: MarketId | 'ALL';
  /** 各市場現金（兩個獨立帳戶） */
  cashBalance: Record<MarketId, number>;
  cashReservePct: number;
  useMultiTimeframe?: boolean;
  holdings: Holding[];
  currentPrices?: Record<string, number>;
}

/** 呼叫 /api/daily-action 取回今日操作清單 */
export async function fetchDailyActionList(
  input: FetchDailyActionInput,
): Promise<DailyActionList> {
  const res = await fetch('/api/daily-action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  // apiOk 把 data 攤平到 top level 並加上 ok 旗標
  if (json.ok === false) {
    throw new Error(json.error ?? 'unknown error');
  }
  // 移除 ok 旗標後返回剩餘部分當 DailyActionList
  const { ok, ...rest } = json;
  void ok;
  return rest as DailyActionList;
}
