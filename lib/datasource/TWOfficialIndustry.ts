/**
 * 台股官方產業分類單一事實來源。
 *
 * - 上市：TWSE「上市公司基本資料」OpenAPI
 * - 上櫃：TPEx「上櫃公司基本資料」OpenAPI
 *
 * 這裡只接受交易所正式產業代碼，不混入 AI、CPO、CoWoS 等市場題材。
 * 兩個來源必須同時成功，避免網路異常時用半套母體產生失真的產業排行。
 */

export const TWSE_COMPANY_INFO_URL = 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L';
export const TPEX_COMPANY_INFO_URL = 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O';

export const TW_OFFICIAL_CLASSIFICATION = {
  kind: 'official_industry',
  version: 3,
  label: 'TWSE／TPEx 官方產業別',
  sources: ['TWSE', 'TPEx'] as const,
} as const;

/**
 * 交易所產業代碼 → 正式顯示名稱。
 *
 * 同一代碼在兩個市場未必同名（例如 17：TWSE「金融保險」、TPEx「金融業」），
 * 因此不可再用一張跨市場名稱表硬併。TPEx 18「貿易百貨」與 34「電子商務」已於
 * 2023 年分別併入 38「居家生活」與 36「數位雲端」，不可再列為現行分類。
 */
export const TWSE_OFFICIAL_INDUSTRY_NAMES: Readonly<Record<string, string>> = {
  '01': '水泥工業',
  '02': '食品工業',
  '03': '塑膠工業',
  '04': '紡織纖維',
  '05': '電機機械',
  '06': '電器電纜',
  '08': '玻璃陶瓷',
  '09': '造紙工業',
  '10': '鋼鐵工業',
  '11': '橡膠工業',
  '12': '汽車工業',
  '14': '建材營造',
  '15': '航運業',
  '16': '觀光餐旅',
  '17': '金融保險',
  '18': '貿易百貨',
  '19': '綜合',
  '20': '其他',
  '21': '化學工業',
  '22': '生技醫療業',
  '23': '油電燃氣業',
  '24': '半導體業',
  '25': '電腦及週邊設備業',
  '26': '光電業',
  '27': '通信網路業',
  '28': '電子零組件業',
  '29': '電子通路業',
  '30': '資訊服務業',
  '31': '其他電子業',
  '35': '綠能環保',
  '36': '數位雲端',
  '37': '運動休閒',
  '38': '居家生活',
};

export const TPEX_OFFICIAL_INDUSTRY_NAMES: Readonly<Record<string, string>> = {
  '02': '食品工業',
  '03': '塑膠工業',
  '04': '紡織纖維',
  '05': '電機機械',
  '06': '電器電纜',
  '08': '玻璃陶瓷',
  '10': '鋼鐵工業',
  '11': '橡膠工業',
  '14': '建材營造',
  '15': '航運業',
  '16': '觀光餐旅',
  '17': '金融業',
  '20': '其他',
  '21': '化學工業',
  '22': '生技醫療',
  '23': '油電燃氣業',
  '24': '半導體業',
  '25': '電腦及週邊設備業',
  '26': '光電業',
  '27': '通信網路業',
  '28': '電子零組件業',
  '29': '電子通路業',
  '30': '資訊服務業',
  '31': '其他電子業',
  '32': '文化創意業',
  '33': '農業科技業',
  '35': '綠能環保',
  '36': '數位雲端',
  '37': '運動休閒',
  '38': '居家生活',
  '80': '管理股票',
};

export type TwOfficialMarket = 'TWSE' | 'TPEx';

export interface TwOfficialIndustryStock {
  code: string;
  name: string;
  market: TwOfficialMarket;
  symbol: string;
  industryCode: string;
  industry: string;
}

export interface TwOfficialIndustryGroup {
  id: string;
  industryCode: string;
  industry: string;
  markets: TwOfficialMarket[];
  stocks: TwOfficialIndustryStock[];
}

export interface TwseCompanyInfoRow {
  公司代號?: string;
  公司簡稱?: string;
  公司名稱?: string;
  產業別?: string;
}

export interface TpexCompanyInfoRow {
  SecuritiesCompanyCode?: string;
  CompanyAbbreviation?: string;
  CompanyName?: string;
  SecuritiesIndustryCode?: string;
}

const CACHE_TTL = 24 * 60 * 60 * 1000;
const MIN_TWSE_COMMON_STOCKS = 900;
const MIN_TPEX_COMMON_STOCKS = 700;
let rosterCache: { fetchedAt: number; stocks: TwOfficialIndustryStock[] } | null = null;

function clean(value: string | undefined): string {
  return (value ?? '').replace(/\u3000/g, ' ').trim();
}

function validCommonStockCode(code: string): boolean {
  return /^[1-9]\d{3}$/.test(code);
}

export function officialIndustryName(market: TwOfficialMarket, industryCode: string): string | undefined {
  return market === 'TWSE'
    ? TWSE_OFFICIAL_INDUSTRY_NAMES[industryCode]
    : TPEX_OFFICIAL_INDUSTRY_NAMES[industryCode];
}

function officialNamesForCode(industryCode: string): Set<string> {
  return new Set([
    TWSE_OFFICIAL_INDUSTRY_NAMES[industryCode],
    TPEX_OFFICIAL_INDUSTRY_NAMES[industryCode],
  ].filter((name): name is string => !!name));
}

/** 穩定的官方產業主鍵；同代碼跨市場正式名稱不同時，以市場拆開。 */
export function officialIndustryGroupId(
  industryCode: string,
  industry: string,
  markets: TwOfficialMarket[],
): string {
  const names = officialNamesForCode(industryCode);
  if (!names.has(industry)) throw new Error(`未知官方產業名稱：${industryCode} ${industry}`);
  return names.size > 1 ? `${[...markets].sort().join('+')}:${industryCode}` : industryCode;
}

/**
 * 官方端新增代碼時不可靜默略過，否則總檔數仍可能超過門檻、卻漏掉整個新產業。
 * TWSE 91 是臺灣存託憑證，不是上市普通股產業，明確排除而非視為未知。
 */
export function unknownOfficialIndustryCodes(
  twseRows: TwseCompanyInfoRow[],
  tpexRows: TpexCompanyInfoRow[],
): { TWSE: string[]; TPEx: string[] } {
  const twse = new Set<string>();
  const tpex = new Set<string>();
  for (const row of twseRows) {
    const code = clean(row.公司代號);
    const industryCode = clean(row.產業別);
    if (validCommonStockCode(code) && industryCode !== '91' && !officialIndustryName('TWSE', industryCode)) {
      twse.add(industryCode || '(空白)');
    }
  }
  for (const row of tpexRows) {
    const code = clean(row.SecuritiesCompanyCode);
    const industryCode = clean(row.SecuritiesIndustryCode);
    if (validCommonStockCode(code) && !officialIndustryName('TPEx', industryCode)) {
      tpex.add(industryCode || '(空白)');
    }
  }
  return { TWSE: [...twse].sort(), TPEx: [...tpex].sort() };
}

export function duplicateOfficialStockCodes(
  twseRows: TwseCompanyInfoRow[],
  tpexRows: TpexCompanyInfoRow[],
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const codes = [
    ...twseRows.map((row) => clean(row.公司代號)),
    ...tpexRows.map((row) => clean(row.SecuritiesCompanyCode)),
  ].filter(validCommonStockCode);
  for (const code of codes) {
    if (seen.has(code)) duplicates.add(code);
    seen.add(code);
  }
  return [...duplicates].sort();
}

/** 純解析函式；輸入由測試或兩個官方 OpenAPI 提供。 */
export function parseOfficialIndustryRows(
  twseRows: TwseCompanyInfoRow[],
  tpexRows: TpexCompanyInfoRow[],
): TwOfficialIndustryStock[] {
  const stocks = new Map<string, TwOfficialIndustryStock>();

  for (const row of twseRows) {
    const code = clean(row.公司代號);
    const industryCode = clean(row.產業別);
    const industry = officialIndustryName('TWSE', industryCode);
    const name = clean(row.公司簡稱) || clean(row.公司名稱);
    // 排除 ETF、權證與 91 存託憑證；只收交易所正式產業代碼下的普通公司股票。
    if (!validCommonStockCode(code) || !industry || !name) continue;
    stocks.set(code, { code, name, market: 'TWSE', symbol: `${code}.TW`, industryCode, industry });
  }

  for (const row of tpexRows) {
    const code = clean(row.SecuritiesCompanyCode);
    const industryCode = clean(row.SecuritiesIndustryCode);
    const industry = officialIndustryName('TPEx', industryCode);
    const name = clean(row.CompanyAbbreviation) || clean(row.CompanyName);
    if (!validCommonStockCode(code) || !industry || !name) continue;
    stocks.set(code, { code, name, market: 'TPEx', symbol: `${code}.TWO`, industryCode, industry });
  }

  return [...stocks.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function groupOfficialIndustryStocks(
  stocks: TwOfficialIndustryStock[],
): TwOfficialIndustryGroup[] {
  const groups = new Map<string, TwOfficialIndustryStock[]>();
  for (const stock of stocks) {
    // 大多數代碼跨市場同名，可合併；正式名稱不同時必須分組，不能用其中一方覆蓋另一方。
    const key = `${stock.industryCode}:${stock.industry}`;
    const list = groups.get(key);
    if (list) list.push(stock);
    else groups.set(key, [stock]);
  }

  return [...groups.entries()]
    .sort(([, a], [, b]) => a[0].industryCode.localeCompare(b[0].industryCode) || a[0].industry.localeCompare(b[0].industry))
    .map(([, members]) => {
      const { industryCode, industry } = members[0];
      const markets = [...new Set(members.map((stock) => stock.market))].sort() as TwOfficialMarket[];
      return {
        id: officialIndustryGroupId(industryCode, industry, markets),
        industryCode,
        industry,
        markets,
        stocks: members,
      };
    });
}

export function buildOfficialIndustryPeerMap(
  stocks: TwOfficialIndustryStock[],
): Map<string, string[]> {
  const peers = new Map<string, string[]>();
  for (const group of groupOfficialIndustryStocks(stocks)) {
    const codes = group.stocks.map((stock) => stock.code);
    for (const code of codes) peers.set(code, codes.filter((peer) => peer !== code));
  }
  return peers;
}

async function fetchRows<T>(url: string): Promise<T[]> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`官方產業資料 HTTP ${response.status}: ${url}`);
      const rows = await response.json() as unknown;
      if (!Array.isArray(rows) || rows.length === 0) throw new Error(`官方產業資料為空: ${url}`);
      return rows as T[];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`官方產業資料讀取失敗: ${url}`);
}

/** 取得上市＋上櫃完整官方產業母體；24 小時記憶體快取。 */
export async function fetchTwOfficialIndustryRoster(): Promise<TwOfficialIndustryStock[]> {
  if (rosterCache && Date.now() - rosterCache.fetchedAt < CACHE_TTL) return rosterCache.stocks;

  const [twseRows, tpexRows] = await Promise.all([
    fetchRows<TwseCompanyInfoRow>(TWSE_COMPANY_INFO_URL),
    fetchRows<TpexCompanyInfoRow>(TPEX_COMPANY_INFO_URL),
  ]);
  const unknown = unknownOfficialIndustryCodes(twseRows, tpexRows);
  if (unknown.TWSE.length > 0 || unknown.TPEx.length > 0) {
    throw new Error(`官方產業出現未支援代碼：TWSE=${unknown.TWSE.join(',') || '無'}；TPEx=${unknown.TPEx.join(',') || '無'}`);
  }
  const duplicateCodes = duplicateOfficialStockCodes(twseRows, tpexRows);
  const stocks = parseOfficialIndustryRows(twseRows, tpexRows);
  const twseCount = stocks.filter((stock) => stock.market === 'TWSE').length;
  const tpexCount = stocks.filter((stock) => stock.market === 'TPEx').length;
  if (twseCount < MIN_TWSE_COMMON_STOCKS || tpexCount < MIN_TPEX_COMMON_STOCKS || duplicateCodes.length > 0) {
    throw new Error(
      `官方產業母體異常：TWSE=${twseCount}、TPEx=${tpexCount}、重複代碼=${duplicateCodes.join(',') || '無'}，拒絕產生不完整排行`,
    );
  }
  rosterCache = { fetchedAt: Date.now(), stocks };
  return stocks;
}

export async function fetchTwOfficialIndustryMap(): Promise<Map<string, string>> {
  const stocks = await fetchTwOfficialIndustryRoster();
  return new Map(stocks.map((stock) => [stock.code, stock.industry]));
}
