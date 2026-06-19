/**
 * 陸股板塊成分股逐檔績效（lazy，點開板塊才呼叫）
 * GET /api/cn-sectors/board-members?code=BKxxxx[&date=YYYY-MM-DD]
 *
 * code 必填（板塊代碼）；date 不帶 → 最新有 boards 檔的日。即時抓成分股 + Tencent 日K
 * 算 1~10/20 日滾動報酬，記憶體快取 5 分鐘（鏡像 /api/themes/hot）避免點開重抓。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { buildBoardMembersPerf } from '@/lib/cn-agents/boardMembersPerf';
import { listBoardsDates } from '@/lib/cn-agents/storage';
import { globalCache } from '@/lib/datasource/MemoryCache';

export const runtime = 'nodejs';

const CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (!code || !/^BK\d+$/i.test(code)) return apiError('缺少或非法板塊代碼 code（要 BKxxxx）', 400);

  let date = req.nextUrl.searchParams.get('date');
  if (!date) {
    const dates = await listBoardsDates();
    if (dates.length === 0) return apiError('no boards snapshot available', 404);
    date = dates[dates.length - 1];
  }

  const cacheKey = `cn-board-members:${code}:${date}`;
  const cached = globalCache.get<Awaited<ReturnType<typeof buildBoardMembersPerf>>>(cacheKey);
  if (cached) return apiOk(cached);

  const file = await buildBoardMembersPerf(code, date);
  globalCache.set(cacheKey, file, CACHE_TTL);
  return apiOk(file);
}
