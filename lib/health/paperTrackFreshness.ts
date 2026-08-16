export type PaperTrackFreshnessLevel = 'ok' | 'warning' | 'stale' | 'missing';

export interface PaperTrackFreshness {
  level: PaperTrackFreshnessLevel;
  ageDays: number | null;
  message: string;
}

/**
 * Paper-trade 是每日排程，超過 3 個日曆日沒有更新就不能再標成 live。
 * 週末最多只跨 2 日，因此 3 日門檻可容納正常休市又能抓出真正停擺。
 */
export function assessPaperTrackFreshness(
  updatedAt: string | null | undefined,
  nowMs = Date.now(),
): PaperTrackFreshness {
  if (!updatedAt) return { level: 'missing', ageDays: null, message: '尚無 paper-trade 更新時間' };
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return { level: 'missing', ageDays: null, message: 'paper-trade 更新時間格式錯誤' };
  const ageDays = Math.max(0, (nowMs - updatedMs) / 86_400_000);
  if (ageDays > 3) {
    return { level: 'stale', ageDays, message: `paper-trade 已 ${Math.floor(ageDays)} 天未更新，不能視為即時追蹤` };
  }
  if (ageDays > 1.5) {
    return { level: 'warning', ageDays, message: `paper-trade 已 ${Math.floor(ageDays)} 天未更新，請確認排程` };
  }
  return { level: 'ok', ageDays, message: 'paper-trade 更新正常' };
}
