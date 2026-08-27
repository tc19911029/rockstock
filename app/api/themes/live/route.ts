/**
 * 台股盤中即時「官方產業」排行
 * GET /api/themes/live[?date=YYYY-MM-DD]
 *
 * 用 TWSE／TPEx 官方產業完整成分股名單（與盤後 sectorRanking 同一份），逐檔配 L2 全市場
 * 即時快照的當日漲跌（鐵則 #3 的快照粗掃，不逐檔讀 Blob）→ 每個題材的全部成分股都列、不靠熱度
 * 過濾。回傳加 marketOpen + updatedAt。純顯示層、不參與
 * 選股（鐵則 #5）。記憶體快取 40s。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { buildLiveThemeRoster, buildLatestLiveThemeRoster, type LiveThemeRosterFile } from '@/lib/themes/liveThemes';
import { globalCache } from '@/lib/datasource/MemoryCache';
import { isMarketOpen } from '@/lib/datasource/marketHours';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';
import { refreshIntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { isValidYmd } from '@/lib/utils/ymd';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_TTL = 40 * 1000;

type LivePayload = LiveThemeRosterFile & {
  marketOpen: boolean;
  stale: boolean;
  staleReason: string | null;
  updatedAt: string;
  refreshAttempted?: boolean;
};

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  if (date && !isValidYmd(date)) return apiError(`invalid date: ${date}`, 400);
  const forceRefresh = req.nextUrl.searchParams.get('refresh') === '1' && !date;
  const cacheKey = `live-themes:TW:${date ?? 'latest'}`;
  const cached = forceRefresh ? null : globalCache.get<LivePayload>(cacheKey);
  if (cached) return apiOk(cached);

  // 手動刷新必須真的重抓 L2，而不是只清 React state 後又命中同一份 40 秒快取。
  // refreshIntradaySnapshot 本身有 single-flight、來源冷卻與空快照保護，不會覆寫好資料。
  if (forceRefresh) {
    await refreshIntradaySnapshot('TW', { retryOnEmpty: false }).catch((error) => {
      console.warn('[themes/live] 手動刷新 L2 失敗:', error instanceof Error ? error.message : error);
    });
  }

  let file: LiveThemeRosterFile | null;
  try {
    file = date
      ? await buildLiveThemeRoster(date)
      : await buildLatestLiveThemeRoster();
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'official industry unavailable', 503);
  }
  if (!file) {
    return apiError(date ? `no L2 snapshot for ${date}` : 'no L2 snapshot available', 404);
  }

  const freshness = assessIntradayFreshness('TW', {
    date: file.date,
    updatedAt: file.snapshotUpdatedAt,
    count: file.themes.reduce((sum, theme) => sum + theme.quotedCount, 0),
  });
  const payload: LivePayload = {
    ...file,
    marketOpen: isMarketOpen('TW'),
    stale: freshness.stale,
    staleReason: freshness.reason,
    updatedAt: file.snapshotUpdatedAt,
    refreshAttempted: forceRefresh,
  };
  globalCache.set(cacheKey, payload, CACHE_TTL);
  return apiOk(payload, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
