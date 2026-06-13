/**
 * GET /api/youtube/health
 *
 * 回傳 health.json + 衍生紅綠燈。
 */

import { apiError, apiOk } from '@/lib/api/response';
import { loadHealth } from '@/lib/youtube/videoStorage';
import type { YouTubeSourceHealth } from '@/lib/youtube/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type LightLevel = 'green' | 'yellow' | 'red' | 'gray';

/**
 * 5 級狀態(2026-05-25 user 要求區分「真的抓到」vs「scan 跑了但沒新節目」)
 *
 * fetched   = 今日有抓到新節目並寫入 videos/{date}.json(analyzable_count > 0)
 * no_new    = 今日 playlist 掃了但無當日 program_date 新節目(IRREGULAR 節目常見)
 * failed    = scan 抓取失敗(API 失敗 / 解析失敗 / 完全抓不到 + 有 error)
 * pending   = 今日尚未掃描(scanned=0 且無 error,排程還沒跑)
 * stale     = 連續空日警告(DAILY 應該每天有但連續 N 日空)
 */
export type FetchStatus = 'fetched' | 'no_new' | 'failed' | 'pending' | 'stale';

function isFatalError(error: string | null, scanned: number): boolean {
  if (!error) return false;
  return scanned === 0;
}

/**
 * 衍生 fetch 狀態 — 以「實際當日新節目」為準
 */
export function deriveFetchStatus(h: YouTubeSourceHealth): FetchStatus {
  // 1. 失敗:有 error + 完全沒抓到任何影片
  if (isFatalError(h.today.error, h.today.scanned)) return 'failed';
  // 2. 尚未抓取:scan 還沒跑
  if (h.today.scanned === 0 && !h.today.error && h.last_scan_at == null) return 'pending';
  if (h.today.scanned === 0 && h.expected_cadence === 'daily' && !h.today.error) {
    // daily 應該每日跑,如果今日 scanned=0 但沒 error,可能還沒跑(早上)或已 fail
    // 用 last_scan_at 是否為今日判斷
    return 'pending';
  }
  // 3. 連續空日警告(DAILY 多日無新節目)
  if (h.possible_missing_update) return 'stale';
  if (h.expected_cadence === 'daily' && h.consecutive_empty_days >= 4) return 'stale';
  // 4. 有抓到當日新節目
  if (h.today.analyzable > 0) return 'fetched';
  // 5. scan 跑了但沒新節目(IRREGULAR 節目今天沒發 / DAILY 節目尚未發片)
  return 'no_new';
}

/** 燈號:狀態 → light color 映射 */
export function fetchStatusToLight(status: FetchStatus, cadence: YouTubeSourceHealth['expected_cadence']): LightLevel {
  switch (status) {
    case 'failed':  return 'red';
    case 'stale':   return cadence === 'daily' ? 'red' : 'yellow';  // daily 久了沒新 → 紅 / 其他黃
    case 'pending': return 'gray';
    case 'no_new':  return 'gray';   // 無新節目不算錯誤,中性灰
    case 'fetched': return 'green';
  }
}

/** 向下相容:既有 caller 用 deriveSourceLight */
export function deriveSourceLight(h: YouTubeSourceHealth): LightLevel {
  return fetchStatusToLight(deriveFetchStatus(h), h.expected_cadence);
}

/** 狀態中文 label(給 UI 用)*/
export const FETCH_STATUS_LABEL: Record<FetchStatus, string> = {
  fetched: '✓ 今日已抓到',
  no_new:  '— 今日無新節目',
  failed:  '⚠ 抓取失敗',
  pending: '○ 尚未掃描',
  stale:   '⚠ 連續空日警告',
};

/** 關鍵幀管線狀態（請求時從 keyframe-index 聚合；不寫 health.json 避免雙寫競態） */
export interface KeyframeHealthRow {
  source_id: string;
  enabled: boolean;
  analyzable: number;
  done: number;
  failed: number;
  frames_kept: number;
}

async function buildKeyframeHealth(date: string): Promise<KeyframeHealthRow[]> {
  const [{ loadKeyframeIndex }, { loadSources, loadVideosForDate }] = await Promise.all([
    import('@/lib/youtube/keyframeStorage'),
    import('@/lib/youtube/videoStorage'),
  ]);
  const [index, sources, videos] = await Promise.all([
    loadKeyframeIndex(), loadSources(), loadVideosForDate(date),
  ]);
  const rows: KeyframeHealthRow[] = [];
  for (const s of sources.filter(x => x.active && x.keyframe_enabled)) {
    const vids = videos.filter(v => v.source_id === s.source_id && v.should_analyze);
    let done = 0, failed = 0, frames = 0;
    for (const v of vids) {
      const e = index.byId[v.video_id];
      if (!e) continue;
      if (e.status === 'ok' || e.status === 'skipped_too_long') done += 1;
      else failed += 1;
      frames += e.frames_kept;
    }
    rows.push({
      source_id: s.source_id,
      enabled: true,
      analyzable: vids.length,
      done, failed, frames_kept: frames,
    });
  }
  return rows;
}

export async function GET() {
  try {
    const snapshot = await loadHealth();
    if (!snapshot) {
      return apiOk({
        snapshot: null,
        message: 'no health snapshot yet — cron has not run',
      });
    }
    const lights = snapshot.sources.map(s => {
      const status = deriveFetchStatus(s);
      return {
        source_id: s.source_id,
        light: fetchStatusToLight(status, s.expected_cadence),
        status,
        statusLabel: FETCH_STATUS_LABEL[status],
      };
    });
    const overall: LightLevel = lights.some(l => l.light === 'red')
      ? 'red'
      : lights.some(l => l.light === 'yellow') ? 'yellow'
      : lights.some(l => l.light === 'green') ? 'green' : 'gray';

    // 關鍵幀狀態（只列 keyframe_enabled 來源；失敗不阻擋主 health 回應）
    let keyframes: KeyframeHealthRow[] = [];
    try {
      const { todayYmdTaipei } = await import('@/lib/youtube/classify');
      keyframes = await buildKeyframeHealth(todayYmdTaipei(new Date()));
    } catch { /* 略過 */ }

    return apiOk({ snapshot, lights, overall, keyframes });
  } catch (err) {
    return apiError(`loadHealth failed: ${(err as Error).message}`, 500);
  }
}
