/** 台股市場題材盤後排行；分類非交易所官方，行情與成分身分以官方快照校驗。 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { readLatestSectorRanking, readPriorSectorRanking, readSectorRanking } from '@/lib/themes/sectorRanking';
import { buildMarketThemeRanking } from '@/lib/themes/marketThemes';
import { computeRotation } from '@/lib/themes/themeRotation';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { isValidYmd } from '@/lib/utils/ymd';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date');
  if (date && !isValidYmd(date)) return apiError(`invalid date: ${date}`, 400);
  if (date && !isTradingDay(date, 'TW')) return apiError(`not a TW trading day: ${date}`, 400);
  if (date && date > getLastTradingDay('TW')) return apiError(`date is not closed yet: ${date}`, 400);
  const official = date ? await readSectorRanking(date) : await readLatestSectorRanking();
  if (!official) return apiError(date ? `no market theme basis for ${date}` : 'no valid market theme basis available', date ? 404 : 503);
  const priorOfficial = await readPriorSectorRanking(official.date);
  const file = buildMarketThemeRanking(official);
  const prior = priorOfficial ? buildMarketThemeRanking(priorOfficial) : null;
  const rotation = computeRotation(file, prior);
  return apiOk({
    ...file,
    priorDate: prior?.date ?? null,
    themes: file.themes.map((theme) => ({ ...theme, rotation: rotation.get(theme.industryId) ?? null })),
  });
}
