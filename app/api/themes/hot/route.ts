/**
 * 今日全市場熱門題材（2026-06-19）
 * GET /api/themes/hot[?date=YYYY-MM-DD]
 *
 * 不帶 date：回最近一個有 L2 快照的交易日；帶 date：回該日（無快照 404）。
 * 即時讀單一 L2 全市場快照算（鐵則 #3 的快照粗掃），記憶體快取 5 分鐘避免每次輪詢重算。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { buildHotThemeScan, buildLatestHotThemeScan } from '@/lib/themes/hotThemeScan';
import { globalCache } from '@/lib/datasource/MemoryCache';

export const runtime = 'nodejs';

const CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  const cacheKey = `hot-themes:TW:${date ?? 'latest'}`;
  const cached = globalCache.get<Awaited<ReturnType<typeof buildHotThemeScan>>>(cacheKey);
  if (cached) return apiOk(cached);

  const file = date ? await buildHotThemeScan(date) : await buildLatestHotThemeScan();
  if (!file) {
    return apiError(date ? `no L2 snapshot for ${date}` : 'no L2 snapshot available', 404);
  }
  globalCache.set(cacheKey, file, CACHE_TTL);
  return apiOk(file);
}
