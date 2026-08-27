/** Tide 專用 110 市場題材盤後排行；底層行情與股票身分仍取官方快照。 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { buildTideMarketThemeRanking } from '@/lib/tide/themeUniverse';
import { readLatestSectorRanking, readPriorSectorRanking, readSectorRanking } from '@/lib/themes/sectorRanking';
import { computeRotation } from '@/lib/themes/themeRotation';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { isValidYmd } from '@/lib/utils/ymd';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  if (date && !isValidYmd(date)) return apiError(`invalid date: ${date}`, 400);
  if (date && !isTradingDay(date, 'TW')) return apiError(`not a TW trading day: ${date}`, 400);
  if (date && date > getLastTradingDay('TW')) return apiError(`date is not closed yet: ${date}`, 400);
  const official = date ? await readSectorRanking(date) : await readLatestSectorRanking();
  if (!official) return apiError(date ? `no Tide theme basis for ${date}` : 'no valid Tide theme basis available', date ? 404 : 503);
  const priorOfficial = await readPriorSectorRanking(official.date);
  const file = buildTideMarketThemeRanking(official);
  const prior = priorOfficial ? buildTideMarketThemeRanking(priorOfficial) : null;
  const rotation = computeRotation(file, prior);
  return apiOk({
    ...file,
    priorDate: prior?.date ?? null,
    themes: file.themes.map((theme) => ({ ...theme, rotation: rotation.get(theme.industryId) ?? null })),
  });
}
