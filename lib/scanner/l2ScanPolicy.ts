import type { IntradaySnapshot } from '@/lib/datasource/IntradayCache';

export type ScanSessionType = 'post_close' | 'intraday';

/**
 * L2 是盤中暫存層，不是正式收盤來源。
 * 盤後掃描必須只讀通過 verify 的 L1，避免凍結中的半根日 K 覆蓋正式 close/volume。
 */
export function canInjectL2ForScan(sessionType: ScanSessionType): boolean {
  return sessionType === 'intraday';
}

/** 盤中注入也要拒絕日期不符、空快照或無法解析 updatedAt 的資料。 */
export function usableIntradaySnapshot(
  snapshot: IntradaySnapshot | null,
  expectedDate: string,
): snapshot is IntradaySnapshot {
  if (!snapshot || snapshot.date !== expectedDate || snapshot.quotes.length === 0) return false;
  return Number.isFinite(Date.parse(snapshot.updatedAt));
}
