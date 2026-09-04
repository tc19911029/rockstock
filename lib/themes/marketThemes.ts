/**
 * Rockstock 台股市場題材顯示層。
 *
 * 題材名單採專案維護的 THEME_MAP（CPO、ASIC、CoWoS…），不是交易所正式分類；
 * 股票身分、名稱、TW/TWO 後綴與行情／法人數值一律取自已驗證官方產業快照。
 * 同一檔可屬多個題材，未命中題材不代表不是上市櫃股票。
 */
import { THEME_MAP } from './themeMap';
import { INST_PERIODS } from './perfPeriods';
import { classifyStage, type SectorRankingFile, type ThemeRank, type ThemeStockPerf } from './sectorRanking';
import type { HotStock, HotTheme, HotThemeScanFile } from './hotThemeScan';
import type { LiveTheme, LiveThemeMember, LiveThemeRosterFile } from './liveThemes';

export const MARKET_THEME_CLASSIFICATION = {
  kind: 'market_theme',
  version: 1,
  label: '台股市場題材（非交易所官方分類）',
  source: 'Rockstock curated THEME_MAP',
  overlapping: true,
} as const;

export type MarketThemeRank = Omit<ThemeRank, 'industryId' | 'industryCode'> & {
  /** 相容既有 UI 的穩定 key；語意是市場題材，不是官方 industryId。 */
  industryId: string;
  industryCode: 'market_theme';
  configuredCount: number;
  matchedCount: number;
};

export interface MarketThemeRankingFile {
  date: string;
  generatedAt: string;
  classification: typeof MARKET_THEME_CLASSIFICATION;
  basis: Pick<SectorRankingFile, 'classification' | 'universe'>;
  universe: {
    source: 'curated_market_theme_map';
    rosterAsOf: string;
    pointInTime: boolean;
    stockCount: number;
    officialStockCount: number;
    membershipCount: number;
    overlapping: true;
  };
  themes: MarketThemeRank[];
}

const average = (values: Array<number | null>): number | null => {
  const present = values.filter((value): value is number => value != null);
  return present.length > 0 ? +(present.reduce((sum, value) => sum + value, 0) / present.length).toFixed(1) : null;
};

/**
 * 唯一允許把市場題材名稱轉成股票代號的入口。
 * 消費端不得直接引用 THEME_MAP，以免把市場題材誤當交易所官方產業分類。
 */
export function marketThemeCodes(theme: string): string[] {
  return [...new Set((THEME_MAP[theme] ?? []).map((stock) => stock.code))];
}

export function marketThemeNamesForCode(code: string): string[] {
  const names: string[] = [];
  for (const [theme, stocks] of Object.entries(THEME_MAP)) {
    if (stocks.some((stock) => stock.code === code)) names.push(theme);
  }
  return names;
}

export function buildMarketThemeRanking(source: SectorRankingFile): MarketThemeRankingFile {
  const memberByCode = new Map<string, ThemeStockPerf>();
  for (const official of source.themes) {
    for (const member of official.members) memberByCode.set(member.code, member);
  }
  const i5 = INST_PERIODS.indexOf(5);
  const themes: MarketThemeRank[] = [];
  for (const theme of Object.keys(THEME_MAP)) {
    const codes = marketThemeCodes(theme);
    const members = codes.map((code) => memberByCode.get(code)).filter((member): member is ThemeStockPerf => member != null);
    if (members.length === 0) continue;
    const avgD1 = average(members.map((member) => member.d1));
    const avgD5 = average(members.map((member) => member.d5));
    const avgD20 = average(members.map((member) => member.d20));
    const avgD60 = average(members.map((member) => member.d60));
    const avgVolRatio = average(members.map((member) => member.volRatio));
    const withD1 = members.filter((member) => member.d1 != null);
    const breadth = withD1.length > 0
      ? +(withD1.filter((member) => (member.d1 ?? 0) > 0).length / withD1.length).toFixed(2)
      : null;
    const instCovered = members.filter((member) => member.instNet5 != null && member.instAmt[i5] != null);
    const instCoverage = +(instCovered.length / members.length).toFixed(4);
    const instNet5 = instCoverage >= 0.8
      ? instCovered.reduce((sum, member) => sum + (member.instNet5 ?? 0), 0)
      : null;
    const instAmt5 = instCoverage >= 0.8
      ? instCovered.reduce((sum, member) => sum + (member.instAmt[i5] ?? 0), 0)
      : null;
    const top = withD1.length > 0
      ? withD1.reduce((best, member) => (member.d1! > best.d1! ? member : best))
      : null;
    themes.push({
      industryId: `market:${theme}`,
      industryCode: 'market_theme',
      markets: [...new Set(members.map((member) => member.market))].sort(),
      theme,
      configuredCount: codes.length,
      matchedCount: members.length,
      stockCount: members.length,
      avgD1,
      avgD5,
      avgD20,
      avgD60,
      avgVolRatio,
      breadth,
      instNet5,
      instAmt5,
      instCoverage,
      stage: classifyStage({ avgD5, avgD20, avgVolRatio }),
      topStock: top && top.d1 != null ? { code: top.code, name: top.name, symbol: top.symbol, d1: top.d1 } : null,
      members,
    });
  }
  themes.sort((left, right) => (right.avgD5 ?? -Infinity) - (left.avgD5 ?? -Infinity));
  const coveredCodes = new Set(themes.flatMap((theme) => theme.members.map((member) => member.code)));
  return {
    date: source.date,
    generatedAt: source.generatedAt,
    classification: MARKET_THEME_CLASSIFICATION,
    basis: { classification: source.classification, universe: source.universe },
    universe: {
      source: 'curated_market_theme_map',
      rosterAsOf: source.universe.rosterAsOf,
      pointInTime: source.universe.pointInTime,
      stockCount: coveredCodes.size,
      officialStockCount: source.universe.stockCount,
      membershipCount: themes.reduce((sum, theme) => sum + theme.stockCount, 0),
      overlapping: true,
    },
    themes,
  };
}

export type MarketLiveThemeRosterFile = Omit<LiveThemeRosterFile, 'classification' | 'themes' | 'themeCount'> & {
  classification: typeof MARKET_THEME_CLASSIFICATION;
  basisClassification: LiveThemeRosterFile['classification'];
  themeCount: number;
  themes: LiveTheme[];
};

export function buildMarketLiveThemeRoster(source: LiveThemeRosterFile): MarketLiveThemeRosterFile {
  const memberByCode = new Map<string, LiveThemeMember>();
  for (const official of source.themes) for (const member of official.members) memberByCode.set(member.code, member);
  const themes: LiveTheme[] = Object.keys(THEME_MAP).flatMap((theme) => {
    const members = marketThemeCodes(theme).map((code) => memberByCode.get(code)).filter((member): member is LiveThemeMember => member != null);
    if (members.length === 0) return [];
    const quoted = members.filter((member): member is LiveThemeMember & { changePercent: number } => member.changePercent != null);
    const top = quoted.length > 0 ? quoted.reduce((best, member) => member.changePercent > best.changePercent ? member : best) : null;
    return [{
      industryId: `market:${theme}`,
      industryCode: 'market_theme',
      markets: [...new Set(members.map((member) => member.market))].sort(),
      theme,
      memberCount: members.length,
      quotedCount: quoted.length,
      upCount: quoted.filter((member) => member.changePercent > 0).length,
      avgChange: quoted.length > 0 ? +(quoted.reduce((sum, member) => sum + member.changePercent, 0) / quoted.length).toFixed(2) : null,
      maxChange: quoted.length > 0 ? +Math.max(...quoted.map((member) => member.changePercent)).toFixed(2) : null,
      topStock: top ? { code: top.code, name: top.name, symbol: top.symbol, changePercent: top.changePercent } : null,
      members,
    }];
  });
  themes.sort((left, right) => (right.avgChange ?? -Infinity) - (left.avgChange ?? -Infinity));
  return { ...source, classification: MARKET_THEME_CLASSIFICATION, basisClassification: source.classification, themeCount: themes.length, themes };
}

export type MarketHotThemeScanFile = Omit<HotThemeScanFile, 'classification'> & {
  classification: typeof MARKET_THEME_CLASSIFICATION;
  basisClassification: HotThemeScanFile['classification'];
};

export function buildMarketHotThemeScan(source: HotThemeScanFile): MarketHotThemeScanFile {
  const stockByCode = new Map<string, HotStock>();
  for (const official of source.themes) for (const member of official.members) stockByCode.set(member.code, member);
  const themes: HotTheme[] = [];
  const categorized = new Set<string>();
  for (const theme of Object.keys(THEME_MAP)) {
    const members = marketThemeCodes(theme)
      .map((code) => stockByCode.get(code))
      .filter((member): member is HotStock => member != null)
      .map((member) => ({ ...member, theme, themeSource: 'concept' as const }))
      .sort((left, right) => right.heat - left.heat);
    if (members.length === 0) continue;
    members.forEach((member) => categorized.add(member.code));
    const hotCount = members.length;
    const avgChange = +(members.reduce((sum, member) => sum + member.changePercent, 0) / hotCount).toFixed(2);
    const maxChange = +Math.max(...members.map((member) => member.changePercent)).toFixed(2);
    const avgHeat = +(members.reduce((sum, member) => sum + member.heat, 0) / hotCount).toFixed(1);
    const top = members.reduce((best, member) => member.changePercent > best.changePercent ? member : best);
    themes.push({
      theme,
      source: 'concept',
      hotCount,
      avgChange,
      maxChange,
      avgHeat,
      score: +(avgHeat + Math.min(hotCount, 8) * 4).toFixed(1),
      topStock: { code: top.code, symbol: top.symbol, name: top.name, changePercent: top.changePercent },
      members,
    });
  }
  themes.sort((left, right) => right.score - left.score);
  return {
    ...source,
    classification: MARKET_THEME_CLASSIFICATION,
    basisClassification: source.classification,
    uncategorizedCount: source.hotStockCount - categorized.size,
    themes,
  };
}
