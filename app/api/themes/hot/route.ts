/**
 * 今日全市場市場題材熱點
 * GET /api/themes/hot[?date=YYYY-MM-DD]
 *
 * 不帶 date：回最近一個有 L2 快照的交易日；帶 date：回該日（無快照 404）。
 * 即時讀單一 L2 全市場快照算（鐵則 #3 的快照粗掃），記憶體快取 5 分鐘避免每次輪詢重算。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { buildHotThemeScan, buildLatestHotThemeScan } from '@/lib/themes/hotThemeScan';
import { buildMarketHotThemeScan, type MarketHotThemeScanFile } from '@/lib/themes/marketThemes';
import { globalCache } from '@/lib/datasource/MemoryCache';
import { isValidYmd } from '@/lib/utils/ymd';

export const runtime = 'nodejs';

const CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  if (date && !isValidYmd(date)) return apiError(`invalid date: ${date}`, 400);
  const cacheKey = `hot-themes:TW:${date ?? 'latest'}`;
  const cached = globalCache.get<MarketHotThemeScanFile>(cacheKey);
  if (cached) return apiOk(cached);

  try {
    const file = date ? await buildHotThemeScan(date) : await buildLatestHotThemeScan();
    if (!file) {
      return apiError(date ? `no L2 snapshot for ${date}` : 'no L2 snapshot available', 404);
    }
    const marketThemes = buildMarketHotThemeScan(file);
    globalCache.set(cacheKey, marketThemes, CACHE_TTL);
    return apiOk(marketThemes);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'market theme basis unavailable', 503);
  }
}
