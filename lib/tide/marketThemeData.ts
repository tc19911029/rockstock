import { readLatestSectorRanking } from '@/lib/themes/sectorRanking';
import { buildTideThemeRanking, type TideThemeRanking } from './themeData';

export type TideMarketThemeRanking = TideThemeRanking;

/**
 * Tide 直接沿用全站最新一份已驗證 TWSE／TPEx 官方產業排行。
 * 顯示層不重新混入人工題材，避免與掃描、三色及產業頁出現不同分類。
 */
export async function loadLatestTideMarketThemes(): Promise<TideMarketThemeRanking | null> {
  return buildTideThemeRanking(await readLatestSectorRanking());
}
