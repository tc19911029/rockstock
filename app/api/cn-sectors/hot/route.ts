/**
 * 陸股今日熱點（人氣榜 + 漲停/炸板池）
 * GET /api/cn-sectors/hot[?date=YYYY-MM-DD]
 *
 * 不帶 date：回最新有 boards 檔的交易日；帶 date：回該日。純讀盤後 cn-agents-eod 已存的
 * hotness/{date}.json（東財人氣榜 top100）+ limitup-pool/{date}.json（漲停/炸板池），不另算。
 * 兩者皆缺 → 404。顯示層（鐵則 #5）。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { readHotnessDay, readLimitUpPoolDay, listBoardsDates } from '@/lib/cn-agents/storage';
import { getCnNameMap } from '@/lib/cn-agents/cnStockNames';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  let date = req.nextUrl.searchParams.get('date');
  if (!date) {
    const dates = await listBoardsDates();
    if (dates.length === 0) return apiError('no snapshot available', 404);
    date = dates[dates.length - 1];
  }

  const [hotness, pool, nameMap] = await Promise.all([
    readHotnessDay(date),
    readLimitUpPoolDay(date),
    getCnNameMap(),
  ]);
  if (!hotness && !pool) return apiError(`no hotness / limit-up data for ${date}`, 404);

  // 人氣榜原始資料常缺名（不含 ST/創業/科創）→ 補本地對照，補不到才維持裸代號
  const hotRank = (hotness?.emRank ?? []).map((e) => ({
    ...e,
    name: e.name ?? nameMap.get(e.symbol) ?? null,
  }));

  return apiOk({
    date,
    hotRank,
    limitUp: pool?.limitUp ?? [],
    broken: pool?.broken ?? [],
    stats: pool?.stats ?? null,
  });
}
