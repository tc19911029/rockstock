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
  version: 1,
  label: 'TWSE／TPEx 官方產業別',
  sources: ['TWSE', 'TPEx'] as const,
} as const;

/**
 * 交易所產業代碼 → 對外顯示名稱。
 * 01、09、11、12、18、19 為 TWSE 類別；32、33 為 TPEx 類別，其餘可跨市場共用。
 * 19「綜合」目前可能沒有成分股，仍保留正式代碼以免未來新增公司時落成未分類。
 */
export const OFFICIAL_INDUSTRY_NAMES: Readonly<Record<string, string>> = {
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
  '32': '文化創意業',
  '33': '農業科技業',
  '35': '綠能環保',
  '36': '數位雲端',
  '37': '運動休閒',
  '38': '居家生活',
};

export type TwOfficialMarket = 'TWSE' | 'TPEx';

export interface TwOfficialIndustryStock {
  code: string;
  name: string;
  market: TwOfficialMarket;
  industryCode: string;
  industry: string;
}

export interface TwOfficialIndustryGroup {
  industryCode: string;
  industry: string;
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
let rosterCache: { fetchedAt: number; stocks: TwOfficialIndustryStock[] } | null = null;

function clean(value: string | undefined): string {
  return (value ?? '').replace(/\u3000/g, ' ').trim();
}

function validCommonStockCode(code: string): boolean {
  return /^[1-9]\d{3}$/.test(code);
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
    const industry = OFFICIAL_INDUSTRY_NAMES[industryCode];
    const name = clean(row.公司簡稱) || clean(row.公司名稱);
    // 排除 ETF、權證與 91 存託憑證；只收交易所正式產業代碼下的普通公司股票。
    if (!validCommonStockCode(code) || !industry || !name) continue;
    stocks.set(code, { code, name, market: 'TWSE', industryCode, industry });
  }

  for (const row of tpexRows) {
    const code = clean(row.SecuritiesCompanyCode);
    const industryCode = clean(row.SecuritiesIndustryCode);
    const industry = OFFICIAL_INDUSTRY_NAMES[industryCode];
    const name = clean(row.CompanyAbbreviation) || clean(row.CompanyName);
    if (!validCommonStockCode(code) || !industry || !name) continue;
    stocks.set(code, { code, name, market: 'TPEx', industryCode, industry });
  }

  return [...stocks.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function groupOfficialIndustryStocks(
  stocks: TwOfficialIndustryStock[],
): TwOfficialIndustryGroup[] {
  const groups = new Map<string, TwOfficialIndustryStock[]>();
  for (const stock of stocks) {
    const list = groups.get(stock.industryCode);
    if (list) list.push(stock);
    else groups.set(stock.industryCode, [stock]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([industryCode, members]) => ({
      industryCode,
      industry: OFFICIAL_INDUSTRY_NAMES[industryCode],
      stocks: members,
    }));
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
  const stocks = parseOfficialIndustryRows(twseRows, tpexRows);
  if (stocks.length < 1_000) {
    throw new Error(`官方產業母體異常：僅 ${stocks.length} 檔，拒絕產生不完整排行`);
  }
  rosterCache = { fetchedAt: Date.now(), stocks };
  return stocks;
}

export async function fetchTwOfficialIndustryMap(): Promise<Map<string, string>> {
  const stocks = await fetchTwOfficialIndustryRoster();
  return new Map(stocks.map((stock) => [stock.code, stock.industry]));
}
