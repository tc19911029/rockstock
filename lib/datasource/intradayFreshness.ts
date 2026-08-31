import { isCNMarketLunchBreak, isMarketOpen } from './marketHours';

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

  const updatedDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(updatedMs));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).format(new Date(updatedMs)).replace(/\u202f/g, ' ').split(':');
  const updatedMinute = Number(parts[0]) * 60 + Number(parts[1]);

  // A 股午休是正常交易中斷：11:30 的上午收盤快照可一路使用到 12:59，
  // 不因自然老化超過 6 分鐘而顯示「無法更新」。13:00 後 isMarketOpen 重新生效，
  // 若尚未拿到下午新行情，舊 11:30 快照會立刻被判 stale，直到下一輪刷新成功。
  if (market === 'CN' && isCNMarketLunchBreak(now)) {
    if (updatedDate !== today || updatedMinute < 11 * 60 + 30) {
      return { stale: true, ageSeconds, reason: '午間快照未包含上午 11:30 收盤價' };
    }
    return { stale: false, ageSeconds, reason: null };
  }

  if (isMarketOpen(market, now)) {
    if (now.getTime() - updatedMs > INTRADAY_MAX_AGE_MS) {
      return { stale: true, ageSeconds, reason: `盤中快照已 ${Math.round(ageSeconds / 60)} 分鐘未更新` };
    }
    return { stale: false, ageSeconds, reason: null };
  }

  const closeMinute = market === 'TW' ? 13 * 60 + 30 : 15 * 60;

  if (updatedDate !== today || updatedMinute < closeMinute) {
    const closeLabel = market === 'TW' ? '13:30' : '15:00';
    return { stale: true, ageSeconds, reason: `今日快照停在收盤 ${closeLabel} 以前` };
  }
  return { stale: false, ageSeconds, reason: null };
}
