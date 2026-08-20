import { isMarketOpen, isPostCloseWindow } from './marketHours';

export interface IntradaySnapshotMeta {
  date: string;
  updatedAt: string;
  count: number;
}

export interface IntradayFreshnessResult {
  stale: boolean;
  ageSeconds: number;
  reason: string | null;
}

export const INTRADAY_MAX_AGE_MS = 6 * 60_000;

/**
 * 判斷「同一天但早盤凍結」的 L2。
 *
 * 只看 snapshot.date 會漏掉 2026-08-20 事故：檔案日期是今天，內容卻停在 10:11，
 * 盤後仍被 health / 題材頁誤標為 fresh。盤中看年齡；收盤後則要求最後更新至少到收盤時間。
 */
export function assessIntradayFreshness(
  market: 'TW' | 'CN',
  snapshot: IntradaySnapshotMeta,
  now = new Date(),
): IntradayFreshnessResult {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  const updatedMs = new Date(snapshot.updatedAt).getTime();
  const ageSeconds = Number.isFinite(updatedMs)
    ? Math.max(0, Math.round((now.getTime() - updatedMs) / 1000))
    : Number.POSITIVE_INFINITY;

  if (snapshot.count <= 0) return { stale: true, ageSeconds, reason: '快照沒有報價' };
  if (snapshot.date !== today) {
    return { stale: true, ageSeconds, reason: `資料日 ${snapshot.date}，不是今天 ${today}` };
  }
  if (!Number.isFinite(updatedMs)) return { stale: true, ageSeconds, reason: '快照更新時間無效' };

  if (isMarketOpen(market, now) || isPostCloseWindow(market, now)) {
    if (now.getTime() - updatedMs > INTRADAY_MAX_AGE_MS) {
      return { stale: true, ageSeconds, reason: `盤中快照已 ${Math.round(ageSeconds / 60)} 分鐘未更新` };
    }
    return { stale: false, ageSeconds, reason: null };
  }

  const updatedDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(updatedMs));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).format(new Date(updatedMs)).replace(/\u202f/g, ' ').split(':');
  const updatedMinute = Number(parts[0]) * 60 + Number(parts[1]);
  const closeMinute = market === 'TW' ? 13 * 60 + 30 : 15 * 60;

  if (updatedDate !== today || updatedMinute < closeMinute) {
    const closeLabel = market === 'TW' ? '13:30' : '15:00';
    return { stale: true, ageSeconds, reason: `今日快照停在收盤 ${closeLabel} 以前` };
  }
  return { stale: false, ageSeconds, reason: null };
}
