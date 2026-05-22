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

export type LightLevel = 'green' | 'yellow' | 'red';

/**
 * 判定 source error 是「致命錯誤」還是「playlist 內個別影片無法存取」。
 * 規則：只要 scanned > 0（成功抓到任何影片），整 source 視為功能正常 — 個別影片
 * 被刪/private/限制存取是 playlist 常態，不該整源紅燈。
 * 只有 scanned === 0（完全抓不到）且有 error，才算 source 真的壞了。
 */
function isFatalError(error: string | null, scanned: number): boolean {
  if (!error) return false;
  return scanned === 0;
}

export function deriveSourceLight(h: YouTubeSourceHealth): LightLevel {
  if (isFatalError(h.today.error, h.today.scanned)) return 'red';
  if (h.possible_missing_update) return 'red';
  if (h.expected_cadence === 'daily' && h.consecutive_empty_days >= 4) return 'red';

  if (h.expected_cadence === 'daily' && h.consecutive_empty_days >= 2) return 'yellow';
  if (h.today.scanned === 0 && h.expected_cadence === 'daily') return 'yellow';
  if (h.today.scanned === 0 && h.expected_cadence === 'weekday') {
    // weekday 來源在週末空檔是正常的
    const dow = new Date().getDay();
    if (dow !== 0 && dow !== 6) return 'yellow';
  }

  return 'green';
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
    const lights = snapshot.sources.map(s => ({
      source_id: s.source_id,
      light: deriveSourceLight(s),
    }));
    const overall: LightLevel = lights.some(l => l.light === 'red')
      ? 'red'
      : lights.some(l => l.light === 'yellow') ? 'yellow' : 'green';

    return apiOk({ snapshot, lights, overall });
  } catch (err) {
    return apiError(`loadHealth failed: ${(err as Error).message}`, 500);
  }
}
