import { readLatestSectorRanking } from '@/lib/themes/sectorRanking';
import { buildMarketThemeRanking } from '@/lib/themes/marketThemes';
import { buildTideThemeRanking, type TideThemeRanking } from './themeData';

export type TideMarketThemeRanking = TideThemeRanking;

/**
 * Tide 使用市場題材；底層成分身分、名稱、後綴與數值仍由官方產業快照提供。
 */
export async function loadLatestTideMarketThemes(): Promise<TideMarketThemeRanking | null> {
  const official = await readLatestSectorRanking();
  return buildTideThemeRanking(official ? buildMarketThemeRanking(official) : null);
}
