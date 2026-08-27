import type { MarketThemeRankingFile, MarketThemeRank } from '@/lib/themes/marketThemes';

export type TideThemeRanking = {
  date: string;
  universe: MarketThemeRankingFile['universe'];
  themes: MarketThemeRank[];
};

/**
 * Tide 顯示市場題材；股票身分與數值已由 buildMarketThemeRanking 以官方快照校驗。
 */
export function buildTideThemeRanking(source: MarketThemeRankingFile | null): TideThemeRanking | null {
  if (!source) return null;
  return { date: source.date, universe: source.universe, themes: source.themes };
}
