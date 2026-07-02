/**
 * 陸股板塊排行（含輪動 + 階段）
 * GET /api/cn-sectors/ranking[?date=YYYY-MM-DD]
 *
 * 不帶 date：回最新有 boards 檔的交易日；帶 date：回該日（無檔 404）。
 * 純讀盤後 cn-agents-eod 已存的 boards/{date}.json + 前一檔算輪動（顯示層，鐵則 #5）。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { buildCnBoardRanking, buildLatestCnBoardRanking } from '@/lib/cn-agents/boardRanking';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  const file = date ? await buildCnBoardRanking(date) : await buildLatestCnBoardRanking();
  if (!file) {
    return apiError(date ? `no boards snapshot for ${date}` : 'no boards snapshot available', 404);
  }
  return apiOk(file);
}
