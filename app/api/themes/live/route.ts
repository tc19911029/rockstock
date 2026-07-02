/**
 * 台股盤中即時「完整題材」排行
 * GET /api/themes/live[?date=YYYY-MM-DD]
 *
 * 用 THEME_MAP 29 個策劃題材的完整成分股名單（與盤後 sectorRanking 同一份），逐檔配 L2 全市場
 * 即時快照的當日漲跌（鐵則 #3 的快照粗掃，不逐檔讀 Blob）→ 每個題材的全部成分股都列、不靠熱度
 * 過濾（記憶體 14 檔全列，不再只剩在漲的 4 檔）。回傳加 marketOpen + updatedAt。純顯示層、不參與
 * 選股（鐵則 #5）。記憶體快取 40s。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { buildLiveThemeRoster, buildLatestLiveThemeRoster, type LiveThemeRosterFile } from '@/lib/themes/liveThemes';
import { globalCache } from '@/lib/datasource/MemoryCache';
import { isMarketOpen } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';

const CACHE_TTL = 40 * 1000;

type LivePayload = LiveThemeRosterFile & { marketOpen: boolean; updatedAt: string };

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  const cacheKey = `live-themes:TW:${date ?? 'latest'}`;
  const cached = globalCache.get<LivePayload>(cacheKey);
  if (cached) return apiOk(cached);

  const file = date
    ? await buildLiveThemeRoster(date)
    : await buildLatestLiveThemeRoster();
  if (!file) {
    return apiError(date ? `no L2 snapshot for ${date}` : 'no L2 snapshot available', 404);
  }

  const payload: LivePayload = {
    ...file,
    marketOpen: isMarketOpen('TW'),
    updatedAt: file.generatedAt,
  };
  globalCache.set(cacheKey, payload, CACHE_TTL);
  return apiOk(payload);
}
