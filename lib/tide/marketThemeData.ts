import { readLatestSectorRanking } from '@/lib/themes/sectorRanking';
import { buildTideThemeRanking, type TideThemeRanking } from './themeData';

export type TideMarketThemeRanking = TideThemeRanking;

/**
 * Tide 直接沿用全站最新一份 TWSE／TPEx 官方產業排行。
 * 顯示層不再用人工名單重新分群，避免與掃描、三色及產業頁出現不同分類。
 */
export async function loadLatestTideMarketThemes(): Promise<TideMarketThemeRanking | null> {
  return buildTideThemeRanking(await readLatestSectorRanking());
}
