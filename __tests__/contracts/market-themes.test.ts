import { buildMarketThemeRanking, marketThemeNamesForCode } from '@/lib/themes/marketThemes';
import type { SectorRankingFile } from '@/lib/themes/sectorRanking';
import { TW_OFFICIAL_CLASSIFICATION } from '@/lib/datasource/TWOfficialIndustry';
import { INST_PERIODS, PERF_PERIODS } from '@/lib/themes/perfPeriods';
import { THEME_MAP, THEME_NAMES } from '@/lib/themes/themeMap';
import { TIDE_MARKET_THEME_GROUPS, groupTideMarketThemes } from '@/lib/tide/themeGroups';

describe('台股市場題材顯示契約', () => {
  const officialMembers = [...new Map(
    Object.values(THEME_MAP).flat()
      .filter((stock) => stock.code !== '6806')
      .map((stock, index) => [stock.code, {
        code: stock.code,
        name: `官方-${stock.code}`,
        symbol: `${stock.code}.TW`,
        market: 'TWSE' as const,
        industryCode: 'fixture',
        d1: index % 10,
        d5: index % 20,
        d20: index % 30,
        d60: index % 40,
        volRatio: 1 + (index % 4) / 10,
        turnover: 1_000_000,
        instNet5: index,
        rets: PERF_PERIODS.map(() => index % 10),
        instAmt: INST_PERIODS.map(() => index * 1_000),
        retailAmt: INST_PERIODS.map(() => 0),
      }]),
  ).values()];
  officialMembers.push({
    code: '9999', name: '官方未收錄題材股', symbol: '9999.TW', market: 'TWSE', industryCode: 'fixture',
    d1: 0, d5: 0, d20: 0, d60: 0, volRatio: 1, turnover: 1_000_000, instNet5: 0,
    rets: PERF_PERIODS.map(() => 0), instAmt: INST_PERIODS.map(() => 0), retailAmt: INST_PERIODS.map(() => 0),
  });
  const official: SectorRankingFile = {
    date: '2026-08-27',
    generatedAt: '2026-08-27T10:00:00.000Z',
    classification: TW_OFFICIAL_CLASSIFICATION,
    universe: { source: 'TWSE_TPEx_company_info', rosterAsOf: '2026-08-27', pointInTime: true, stockCount: officialMembers.length },
    themes: [{
      industryId: 'fixture', industryCode: 'fixture', markets: ['TWSE'], theme: '測試官方產業', stockCount: officialMembers.length,
      avgD1: null, avgD5: null, avgD20: null, avgD60: null, avgVolRatio: null, breadth: null,
      instNet5: null, instAmt5: null, instCoverage: 1, stage: '盤整', topStock: null, members: officialMembers,
    }],
  };
  const market = buildMarketThemeRanking(official);

  test('CPO、ASIC 與全部 38 個市場題材均可直接顯示', () => {
    const names = market.themes.map((theme) => theme.theme);
    expect(names).toHaveLength(38);
    expect(names).toEqual(expect.arrayContaining(['CPO', 'ASIC', 'AI伺服器', 'CoWoS']));
  });

  test('市場題材明確標為非官方且允許一股多題材', () => {
    expect(market.classification).toMatchObject({ kind: 'market_theme', overlapping: true });
    expect(market.universe.membershipCount).toBeGreaterThan(market.universe.stockCount);
    expect(marketThemeNamesForCode('2330')).toEqual(expect.arrayContaining(['CPO', '矽光子', '先進封裝', 'CoWoS']));
  });

  test('題材成分只保留官方股票快照能校驗的代碼、名稱、後綴與市場', () => {
    const officialByCode = new Map(official.themes.flatMap((theme) => theme.members).map((stock) => [stock.code, stock]));
    for (const theme of market.themes) {
      expect(theme.industryId).toBe(`market:${theme.theme}`);
      for (const stock of theme.members) {
        const basis = officialByCode.get(stock.code);
        expect(basis).toBeDefined();
        expect(stock).toMatchObject({ name: basis?.name, symbol: basis?.symbol, market: basis?.market });
      }
    }
    expect(market.themes.flatMap((theme) => theme.members).some((stock) => stock.code === '6806')).toBe(false);
  });

  test('覆蓋率與重疊數量不冒充官方全市場互斥分類', () => {
    expect(market.universe.officialStockCount).toBe(official.universe.stockCount);
    expect(market.universe.stockCount).toBeLessThan(market.universe.officialStockCount);
    expect(market.universe.overlapping).toBe(true);
  });

  test('Tide 的視覺分組完整涵蓋 38 題材且不重複', () => {
    const configured = TIDE_MARKET_THEME_GROUPS.flatMap((group) => group.names);
    expect(new Set(configured).size).toBe(configured.length);
    expect([...configured].sort()).toEqual([...THEME_NAMES].sort());
    expect(groupTideMarketThemes(market.themes).flatMap((group) => group.themes)).toHaveLength(38);
  });
});
