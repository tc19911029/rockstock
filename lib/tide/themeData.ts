import type { SectorRankingFile, ThemeRank } from '@/lib/themes/sectorRanking';

export type TideThemeRanking = {
  date: string;
  universe: SectorRankingFile['universe'];
  themes: ThemeRank[];
};

/**
 * Tide 與全站共用同一份 TWSE／TPEx 官方產業排行，不在顯示層重新混入人工題材。
 */
export function buildTideThemeRanking(source: SectorRankingFile | null): TideThemeRanking | null {
  if (!source) return null;
  return { date: source.date, universe: source.universe, themes: source.themes };
}
