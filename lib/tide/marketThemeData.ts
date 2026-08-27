import { readLatestSectorRanking, readPriorSectorRanking } from '@/lib/themes/sectorRanking';
import { buildTideHighlightThemes, type TideHighlightTheme } from './highlights';
import { buildTideThemeRanking, type TideThemeRanking } from './themeData';
import { buildTideMarketThemeRanking } from './themeUniverse';

export type TideMarketThemeRanking = TideThemeRanking;

export type TideMarketThemeContext = {
  latest: TideMarketThemeRanking | null;
  prior: TideMarketThemeRanking | null;
  latestHighlights: TideHighlightTheme[];
  priorHighlights: TideHighlightTheme[];
};

/**
 * Tide 使用市場題材；底層成分身分、名稱、後綴與數值仍由官方產業快照提供。
 */
export async function loadLatestTideMarketThemes(): Promise<TideMarketThemeRanking | null> {
  const official = await readLatestSectorRanking();
  return buildTideThemeRanking(official ? buildTideMarketThemeRanking(official) : null);
}

/** 同時載入最新與前一交易日題材，讓「回顧」使用真正的前一日排名。 */
export async function loadTideMarketThemeContext(): Promise<TideMarketThemeContext> {
  const official = await readLatestSectorRanking();
  if (!official) return { latest: null, prior: null, latestHighlights: [], priorHighlights: [] };
  const priorOfficial = await readPriorSectorRanking(official.date);
  return {
    latest: buildTideThemeRanking(buildTideMarketThemeRanking(official)),
    prior: buildTideThemeRanking(priorOfficial ? buildTideMarketThemeRanking(priorOfficial) : null),
    latestHighlights: buildTideHighlightThemes(official.themes),
    priorHighlights: buildTideHighlightThemes(priorOfficial?.themes ?? []),
  };
}
