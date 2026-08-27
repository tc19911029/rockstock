import fs from 'node:fs/promises';
import path from 'node:path';
import { TW_CONCEPT_MAP } from '@/lib/scanner/conceptMap';
import { classifyStage, type SectorRankingFile, type ThemeRank, type ThemeStockPerf } from '@/lib/themes/sectorRanking';
import { THEME_MAP } from '@/lib/themes/themeMap';

export type TideMarketThemeRanking = { date: string; themes: ThemeRank[] };

const TIDE_THEME_COUNT = 108;
const INST_AMT_5_INDEX = 4;
const SECTOR_DATA_DIR = path.join(process.cwd(), 'data', 'sectors', 'TW');

type LooseMember = Partial<ThemeStockPerf> & Pick<ThemeStockPerf, 'code' | 'name'>;
type LooseTheme = Partial<ThemeRank> & Pick<ThemeRank, 'theme'> & { members?: LooseMember[] };
type LooseRanking = Partial<SectorRankingFile> & { date?: string; themes?: LooseTheme[] };

function average(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value != null);
  return valid.length === 0 ? null : Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(1));
}

function normalizeMember(member: LooseMember): ThemeStockPerf {
  const symbol = member.symbol ?? member.code;
  return {
    code: member.code,
    name: member.name,
    symbol,
    market: member.market ?? (symbol.endsWith('.TWO') ? 'TPEx' : 'TWSE'),
    d1: member.d1 ?? null,
    d5: member.d5 ?? null,
    d20: member.d20 ?? null,
    d60: member.d60 ?? null,
    volRatio: member.volRatio ?? null,
    turnover: member.turnover ?? null,
    instNet5: member.instNet5 ?? null,
    rets: member.rets ?? [],
    instAmt: member.instAmt ?? [],
    retailAmt: member.retailAmt ?? [],
  };
}

function aggregateTheme(theme: string, members: ThemeStockPerf[]): ThemeRank {
  const avgD1 = average(members.map((member) => member.d1));
  const avgD5 = average(members.map((member) => member.d5));
  const avgD20 = average(members.map((member) => member.d20));
  const avgD60 = average(members.map((member) => member.d60));
  const avgVolRatio = average(members.map((member) => member.volRatio));
  const withD1 = members.filter((member) => member.d1 != null);
  const breadth = withD1.length === 0 ? null : Number((withD1.filter((member) => (member.d1 ?? 0) > 0).length / withD1.length).toFixed(2));
  const netValues = members.map((member) => member.instNet5).filter((value): value is number => value != null);
  const amountValues = members.map((member) => member.instAmt[INST_AMT_5_INDEX]).filter((value): value is number => value != null);
  const top = withD1.reduce<ThemeStockPerf | null>((best, member) => !best || (member.d1 ?? -Infinity) > (best.d1 ?? -Infinity) ? member : best, null);

  return {
    industryId: `tide:${theme}`,
    industryCode: `TIDE-${theme}`,
    markets: [...new Set(members.map((member) => member.market))],
    theme,
    stockCount: members.length,
    avgD1,
    avgD5,
    avgD20,
    avgD60,
    avgVolRatio,
    breadth,
    instNet5: netValues.length === 0 ? null : netValues.reduce((sum, value) => sum + value, 0),
    instAmt5: amountValues.length === 0 ? null : amountValues.reduce((sum, value) => sum + value, 0),
    stage: classifyStage({ avgD5, avgD20, avgVolRatio }),
    topStock: top?.d1 == null ? null : { code: top.code, name: top.name, symbol: top.symbol, d1: top.d1 },
    members,
  };
}

function buildMarketThemes(source: LooseRanking): TideMarketThemeRanking | null {
  if (!source.date || !Array.isArray(source.themes)) return null;
  const stockByCode = new Map<string, ThemeStockPerf>();
  for (const industry of source.themes) {
    for (const member of industry.members ?? []) {
      if (!stockByCode.has(member.code)) stockByCode.set(member.code, normalizeMember(member));
    }
  }
  if (stockByCode.size === 0) return null;

  const groups = new Map<string, Set<string>>();
  const add = (theme: string, code: string) => {
    const codes = groups.get(theme) ?? new Set<string>();
    codes.add(code);
    groups.set(theme, codes);
  };
  for (const [theme, stocks] of Object.entries(THEME_MAP)) for (const stock of stocks) add(theme, stock.code);
  for (const [code, theme] of Object.entries(TW_CONCEPT_MAP)) add(theme, code);

  const official = [...source.themes].sort((a, b) => Math.abs(b.instAmt5 ?? 0) - Math.abs(a.instAmt5 ?? 0));
  for (const industry of official) {
    if (groups.size >= TIDE_THEME_COUNT) break;
    if (groups.has(industry.theme)) continue;
    for (const member of industry.members ?? []) add(industry.theme, member.code);
  }

  const themes = [...groups.entries()].slice(0, TIDE_THEME_COUNT).map(([theme, codes]) => aggregateTheme(
    theme,
    [...codes].map((code) => stockByCode.get(code)).filter((member): member is ThemeStockPerf => member != null),
  ));
  return { date: source.date, themes };
}

/** 讀原始官方快照並在 Tide 顯示層聚合 108 個市場題材，不受主排名 schema 遷移影響。 */
export async function loadLatestTideMarketThemes(): Promise<TideMarketThemeRanking | null> {
  let filenames: string[];
  try {
    filenames = (await fs.readdir(SECTOR_DATA_DIR)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
  } catch {
    return null;
  }
  for (const filename of filenames) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(SECTOR_DATA_DIR, filename), 'utf8')) as LooseRanking;
      if (parsed.classification?.kind !== 'official_industry') continue;
      const ranking = buildMarketThemes(parsed);
      if (ranking?.themes.length === TIDE_THEME_COUNT) return ranking;
    } catch {
      // 若最新檔正在被原子替換，繼續找前一個完整官方快照。
    }
  }
  return null;
}
