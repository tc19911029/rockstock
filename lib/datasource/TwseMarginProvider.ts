/**
 * TWSE 融資融券公開資料（免費、無 CAPTCHA、無 quota）
 *
 * 取代 FinMind TaiwanStockMarginPurchaseShortSale（會 402 ratelimit）
 *
 * Source: https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=YYYYMMDD&selectType=ALL&response=json
 *   融資融券彙總 — 全市場所有股票單日資料一次回傳
 *
 * Tables[1] 欄位順序：
 *   [代號, 名稱,
 *    融資買進, 融資賣出, 融資現金償還, 融資前日餘額, 融資今日餘額, 融資限額,
 *    融券買進, 融券賣出, 融券現券償還, 融券前日餘額, 融券今日餘額, 融券限額,
 *    資券互抵, 備註]
 *
 * 單位是「張」(lots)，不用轉換。
 */

const TWSE_URL = 'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN';

const CACHE = new Map<string, { rows: TwseMarginRow[]; expiresAt: number }>();
const CACHE_TTL = 6 * 60 * 60_000;

export interface TwseMarginRow {
  date: string;
  stockId: string;
  /** 融資今日餘額（張）*/
  marginBalance: number;
  /** 融資淨變化（今日 ─ 昨日）*/
  marginNet: number;
  /** 融資限額（張）*/
  marginLimit: number;
  /** 融資使用率 % */
  marginUtilRate: number;
  /** 融券今日餘額（張）*/
  shortBalance: number;
  /** 融券淨變化 */
  shortNet: number;
}

interface TwseTable {
  title?: string;
  fields?: string[];
  data?: Array<Array<string>>;
}

interface TwseResp {
  stat?: string;
  tables?: TwseTable[];
}

async function fetchTwseMarginAll(date: string): Promise<TwseMarginRow[]> {
  const cacheKey = `twse:margin:${date}`;
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const url = `${TWSE_URL}?date=${date}&selectType=ALL&response=json`;
  try {
    // TWSE 直連間歇性 connect timeout / TLS reset（2026-06-12 B2 實測）→ curl-first helper
    const { fetchJsonWithCurlFallback } = await import('./curlFetch');
    const { data: json } = await fetchJsonWithCurlFallback<TwseResp>(url);
    if (json.stat !== 'OK' || !Array.isArray(json.tables)) return [];

    // tables[0] 是市場彙總，tables[1] 才是個股
    const stockTable = json.tables.find(t => Array.isArray(t.data) && t.data.length > 100);
    if (!stockTable?.data) return [];

    const dateIso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const toNum = (s: string): number => {
      const n = parseInt(s.replace(/[,]/g, ''), 10);
      return Number.isFinite(n) ? n : 0;
    };

    const result: TwseMarginRow[] = stockTable.data.map(row => {
      const marginPrev = toNum(row[5]);
      const marginCur = toNum(row[6]);
      const marginLimit = toNum(row[7]);
      const shortPrev = toNum(row[11]);
      const shortCur = toNum(row[12]);
      return {
        date: dateIso,
        stockId: row[0],
        marginBalance: marginCur,
        marginNet: marginCur - marginPrev,
        marginLimit,
        marginUtilRate: marginLimit > 0 ? +((marginCur / marginLimit) * 100).toFixed(2) : 0,
        shortBalance: shortCur,
        shortNet: shortCur - shortPrev,
      };
    });

    CACHE.set(cacheKey, { rows: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch {
    return [];
  }
}

export async function fetchTwseMarginForStock(stockId: string, dateIso: string): Promise<TwseMarginRow | null> {
  const dateCompact = dateIso.replace(/-/g, '');
  const all = await fetchTwseMarginAll(dateCompact);
  return all.find(r => r.stockId === stockId) ?? null;
}

/** 全市場單日 bulk（/api/cron/fetch-chip-extras 每日持久化用；2026-06-12 B2）*/
export async function fetchTwseMarginBulk(dateIso: string): Promise<TwseMarginRow[]> {
  return fetchTwseMarginAll(dateIso.replace(/-/g, ''));
}
