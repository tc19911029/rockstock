/**
 * TWSE 個股當沖統計（免費、無 quota；2026-06-12 B2）
 *
 * Source: https://www.twse.com.tw/exchangeReport/TWTB4U?response=json&date=YYYYMMDD&selectType=All
 *   「每日當日沖銷交易標的及統計」— 全市場單日一次回（實測 ~1200 檔）
 *
 * tables 中個股表 fields：
 *   [證券代號, 證券名稱, 暫停現股賣出後現款買進當沖註記, 當日沖銷交易成交股數,
 *    當日沖銷交易買進成交金額, 當日沖銷交易賣出成交金額]
 *
 * 注意：
 *   - 成交股數單位是「股」→ ÷1000 換「張」存（與 chips 其他資料一致）
 *   - 當沖比（占成交量%）不在此表 — 讀取端用 L1 當日 volume 自算
 *   - 上櫃個股當沖：TPEx OpenAPI 只有市場層級彙總（tpex_intraday_trading_statistics），
 *     無個股表（2026-06-12 swagger 確認）→ v1 缺口，上櫃當沖仍走 FinMind fallback
 */

const TWSE_URL = 'https://www.twse.com.tw/exchangeReport/TWTB4U';

const CACHE = new Map<string, { rows: TwseDayTradeRow[]; expiresAt: number }>();
const CACHE_TTL = 6 * 60 * 60_000;

export interface TwseDayTradeRow {
  date: string;          // YYYY-MM-DD
  stockId: string;
  /** 當沖成交量（張） */
  dayTradeLots: number;
  /** 當沖買進成交金額（元） */
  buyValue: number;
  /** 當沖賣出成交金額（元） */
  sellValue: number;
}

interface TwseResp {
  stat?: string;
  tables?: Array<{ fields?: string[]; data?: Array<Array<string>> }>;
}

/** 全市場單日 bulk（/api/cron/fetch-chip-extras 每日持久化用）*/
export async function fetchTwseDayTradeBulk(dateIso: string): Promise<TwseDayTradeRow[]> {
  const dateCompact = dateIso.replace(/-/g, '');
  const cacheKey = `twse:daytrade:${dateCompact}`;
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const url = `${TWSE_URL}?response=json&date=${dateCompact}&selectType=All`;
  try {
    // TWSE 直連間歇性 connect timeout / TLS reset（2026-06-12 實測）→ curl-first helper
    const { fetchJsonWithCurlFallback } = await import('./curlFetch');
    const { data: json } = await fetchJsonWithCurlFallback<TwseResp>(url);
    if (json.stat !== 'OK' || !Array.isArray(json.tables)) return [];

    // tables 含市場彙總與個股表 — 用 fields 含「證券代號」找個股表
    const stockTable = json.tables.find(t =>
      Array.isArray(t.data) && t.data.length > 0 && t.fields?.includes('證券代號'),
    );
    if (!stockTable?.data) return [];

    const toNum = (s: string): number => {
      const n = parseInt(String(s).replace(/[,]/g, ''), 10);
      return Number.isFinite(n) ? n : 0;
    };

    const result: TwseDayTradeRow[] = stockTable.data.map(row => ({
      date: dateIso,
      stockId: String(row[0]).trim(),
      dayTradeLots: Math.round(toNum(row[3]) / 1000),
      buyValue: toNum(row[4]),
      sellValue: toNum(row[5]),
    }));

    CACHE.set(cacheKey, { rows: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch {
    return [];
  }
}
