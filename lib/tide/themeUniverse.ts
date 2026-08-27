import { INST_PERIODS } from '@/lib/themes/perfPeriods';
import {
  MARKET_THEME_CLASSIFICATION,
  type MarketThemeRank,
  type MarketThemeRankingFile,
} from '@/lib/themes/marketThemes';
import { THEME_MAP } from '@/lib/themes/themeMap';
import { classifyStage, type SectorRankingFile, type ThemeStockPerf } from '@/lib/themes/sectorRanking';
import { TIDE_EXACT_THEME_CODES } from './highlights';
import { TIDE_MARKET_THEME_GROUPS, TIDE_THEME_NAMES } from './themeGroups';

/**
 * 原站 110 題材與 Rockstock 既有研究題材的對照。
 * 沒有直接對照的「其他」型題材會落到交易所官方產業母體，再做穩定分組。
 */
const SOURCE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  '矽晶圓': ['矽晶圓'],
  '晶圓代工': ['成熟製程'],
  '晶圓廠設備': ['半導體設備'],
  '前段製程材料': ['矽晶圓', '第三代半導體'],
  '前段製程設備': ['半導體設備'],
  '類比與功率 IC': ['功率元件'],
  '客製 ASIC 矽智財': ['ASIC'],
  'HPC 與網通 IC': ['網通'],
  'CPU 與 Agentic AI': ['ASIC', 'AI伺服器'],
  'NOR Flash 利基記憶體': ['記憶體'],
  '第三代半導體': ['第三代半導體'],
  '顯示驅動 IC': ['面板'],
  'IC 通路': ['半導體通路'],
  'AI 伺服器組裝': ['AI伺服器'],
  '液冷散熱': ['散熱'],
  '氣冷與核心組件': ['散熱'],
  'PCB 載板': ['PCB'],
  '功率電感': ['被動元件'],
  '電容器': ['被動元件'],
  '電阻與被動保護': ['被動元件'],
  '矽光子與 CPO': ['矽光子', 'CPO'],
  'AI 互連元件': ['高速連接'],
  '連接器 工業消費': ['高速連接'],
  '車用連接器': ['高速連接', '車用電子'],
  '玻璃基板': ['玻璃基板'],
  'AI PC 筆電與平板': ['AI伺服器', '蘋果供應鏈'],
  '智慧型手機': ['蘋果供應鏈'],
  'EMS 電子代工': ['AI伺服器', '蘋果供應鏈'],
  '機殼與滑軌': ['AI伺服器'],
  '面板產業': ['面板'],
  'MicroLED 顯示供應鏈': ['面板'],
  '高速交換器與無線網路': ['網通'],
  '低軌衛星': ['低軌衛星'],
  '石英頻率控制': ['被動元件'],
  '日本被動元件': ['被動元件'],
  '離岸風電': ['綠能'],
  '太陽能產業': ['綠能'],
  '儲能系統整合': ['綠能', '電力'],
  '電池關鍵材料': ['綠能', '車用電子'],
  '電芯製造與電池模組': ['綠能', '車用電子'],
  'BBU 電池備援': ['伺服器電源'],
  '電源供應器': ['伺服器電源'],
  '電器電纜': ['重電', '電力'],
  '資源環保工業': ['綠能'],
  '綠能環保・其他': ['綠能'],
  '電器電纜・其他': ['重電', '電力'],
  '銀行金融': ['金融'],
  'CNC 工具機': ['工具機'],
  '石化與塑膠產業': ['中國政策受惠'],
  '國防軍工': ['軍工'],
  '汽車工業・其他': ['車用電子'],
  '運動休閒': ['自行車'],
  '生技醫療': ['生技'],
};

const OFFICIAL_MATCHERS: Readonly<Record<string, RegExp>> = {
  '光電・其他': /^光電業$/,
  '其他電子・其他': /^其他電子業$/,
  '通信網路・其他': /^通信網路業$/,
  '電子通路・其他': /^電子通路業$/,
  '電子零組件・其他': /^電子零組件業$/,
  '電腦週邊・其他': /^電腦及週邊設備業$/,
  '雲端與 MSP': /資訊服務業|數位雲端/,
  '企業 SaaS': /資訊服務業|數位雲端/,
  '資安防護': /資訊服務業|數位雲端/,
  '數位雲端・其他': /^數位雲端$/,
  '資訊服務・其他': /^資訊服務業$/,
  '油電燃氣': /^油電燃氣業$/,
  '其他產業': /^其他$/,
  '化學工業・其他': /^化學工業$/,
  '塑膠・其他': /^塑膠工業$/,
  '橡膠': /^橡膠工業$/,
  '水泥': /^水泥工業$/,
  '玻璃陶瓷': /^玻璃陶瓷$/,
  '紡織成衣': /^紡織纖維$/,
  '造紙': /^造紙工業$/,
  '鋼鐵金屬': /^鋼鐵工業$/,
  '電商零售': /數位雲端|貿易百貨/,
  '居家生活': /^居家生活$/,
  '文化創意': /^文化創意業$/,
  '觀光餐旅': /^觀光餐旅$/,
  '貿易百貨': /^貿易百貨$/,
  '農業科技': /^農業科技業$/,
  '運動休閒': /^運動休閒$/,
  '食品飲料': /^食品工業$/,
  '營建地產': /^建材營造$/,
  '生技醫療': /生技醫療/,
};

const GROUP_FALLBACKS: Readonly<Record<string, RegExp>> = {
  semiconductor: /^半導體業$/,
  'ai-hardware': /電子零組件業|電腦及週邊設備業|通信網路業|光電業|電子通路業|其他電子業/,
  'software-cloud': /資訊服務業|數位雲端|文化創意業/,
  'green-energy': /綠能環保|油電燃氣業|電器電纜/,
  finance: /金融/,
  shipping: /^航運業$/,
  traditional: /水泥工業|塑膠工業|電機機械|電器電纜|化學工業|玻璃陶瓷|造紙工業|鋼鐵工業|橡膠工業|汽車工業|其他/,
  consumer: /食品工業|紡織纖維|貿易百貨|觀光餐旅|運動休閒|居家生活|農業科技業/,
  construction: /^建材營造$/,
  biotech: /生技醫療/,
};

const average = (values: Array<number | null>): number | null => {
  const present = values.filter((value): value is number => value != null);
  return present.length > 0 ? +(present.reduce((sum, value) => sum + value, 0) / present.length).toFixed(1) : null;
};

function stableSlice(theme: string, members: ThemeStockPerf[], size = 8): ThemeStockPerf[] {
  if (members.length <= size) return members;
  const start = [...theme].reduce((sum, char) => sum + char.charCodeAt(0), 0) % members.length;
  return Array.from({ length: size }, (_, index) => members[(start + index) % members.length]);
}

function codesForTheme(theme: string): string[] {
  const exact = TIDE_EXACT_THEME_CODES[theme];
  if (exact) return [...exact];
  const codes = new Set<string>();
  for (const alias of SOURCE_ALIASES[theme] ?? []) {
    for (const stock of THEME_MAP[alias] ?? []) codes.add(stock.code);
  }
  return [...codes];
}

export function buildTideMarketThemeRanking(source: SectorRankingFile): MarketThemeRankingFile {
  const memberByCode = new Map<string, ThemeStockPerf>();
  for (const official of source.themes) for (const member of official.members) memberByCode.set(member.code, member);
  const groupByTheme = new Map<string, string>();
  for (const group of TIDE_MARKET_THEME_GROUPS) for (const name of group.names) groupByTheme.set(name, group.id);
  const i5 = INST_PERIODS.indexOf(5);

  const themes: MarketThemeRank[] = TIDE_THEME_NAMES.map((theme) => {
    const configuredCodes = codesForTheme(theme);
    let members = configuredCodes.map((code) => memberByCode.get(code)).filter((member): member is ThemeStockPerf => member != null);
    const officialMatcher = OFFICIAL_MATCHERS[theme];
    if (officialMatcher) {
      const officialMembers = source.themes.filter((item) => officialMatcher.test(item.theme)).flatMap((item) => item.members);
      members = [...new Map([...members, ...stableSlice(theme, officialMembers)].map((member) => [member.code, member])).values()];
    }
    if (members.length === 0) {
      const fallback = GROUP_FALLBACKS[groupByTheme.get(theme) ?? 'traditional'];
      members = stableSlice(theme, source.themes.filter((item) => fallback.test(item.theme)).flatMap((item) => item.members));
    }

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
    const instCoverage = +(instCovered.length / Math.max(1, members.length)).toFixed(4);
    const instNet5 = instCoverage >= 0.8 ? instCovered.reduce((sum, member) => sum + (member.instNet5 ?? 0), 0) : null;
    const instAmt5 = instCoverage >= 0.8 ? instCovered.reduce((sum, member) => sum + (member.instAmt[i5] ?? 0), 0) : null;
    const top = withD1.length > 0 ? withD1.reduce((best, member) => member.d1! > best.d1! ? member : best) : null;
    return {
      industryId: `market:${theme}`,
      industryCode: 'market_theme',
      markets: [...new Set(members.map((member) => member.market))].sort(),
      theme,
      configuredCount: Math.max(configuredCodes.length, members.length),
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
    };
  });

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
