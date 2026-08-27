/**
 * TWSE／TPEx 官方產業強弱排名查詢（附描述性輪動標籤）
 * GET /api/themes/ranking[?date=YYYY-MM-DD]
 * 不帶 date：回最近一份有效官方快照；帶 date：回該日。
 * 查詢端唯讀；快照只允許由已授權的盤後 cron 建立，避免 GET 汙染歷史資料。
 * 附 rotation（每題材 今日漲幅名次 vs 昨天 + 🟢🟡🔴 桶）— 純描述非訊號。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { readSectorRanking, readLatestSectorRanking, readPriorSectorRanking } from '@/lib/themes/sectorRanking';
import { computeRotation } from '@/lib/themes/themeRotation';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { isValidYmd } from '@/lib/utils/ymd';
import { isTradingDay } from '@/lib/utils/tradingDay';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  if (date && !isValidYmd(date)) {
    return apiError(`invalid date: ${date}`, 400);
  }
  if (date && !isTradingDay(date, 'TW')) return apiError(`not a TW trading day: ${date}`, 400);
  if (date && date > getLastTradingDay('TW')) return apiError(`date is not closed yet: ${date}`, 400);
  const file = date ? await readSectorRanking(date) : await readLatestSectorRanking();
  if (!file) {
    return apiError(date ? `no official industry ranking for ${date}` : 'no valid official industry ranking available', date ? 404 : 503);
  }

  // 找前一交易日的檔，算日輪動（資料不足則 rotation 為 mid/null，UI 自會淡化）
  const prior = await readPriorSectorRanking(file.date);
  const priorDate = prior?.date ?? null;
  const rotation = computeRotation(file, prior);

  const themes = file.themes.map((t) => ({ ...t, rotation: rotation.get(t.industryId) ?? null }));
  return apiOk({ ...file, priorDate, themes });
}
