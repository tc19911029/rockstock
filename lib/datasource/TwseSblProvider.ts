/**
 * TWSE 借券/融券公開資料（免費、無 CAPTCHA、無 quota）
 *
 * 取代 FinMind TaiwanDailyShortSaleBalances（會 402 ratelimit）
 *
 * Source: https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=YYYYMMDD&response=json
 *   信用額度總量管制餘額表 — 全市場所有股票單日 SBL 資料一次回傳
 *
 * 欄位（fields[]）：
 *   [代號, 名稱,
 *    融券前日餘額, 融券賣出, 融券買進, 現券, 融券今日餘額, 融券次一限額,
 *    借券前日餘額, 借券當日賣出, 借券當日還券, 借券當日調整, 借券當日餘額, 借券次一限額, 備註]
 *
 * 注意：單位是「股」(shares)，要 ÷ 1000 換成「張」(lots)。
 */

const TWSE_URL = 'https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U';

// 本地 cache（同一天的全市場資料一次抓完、各檔股票共用）
const CACHE = new Map<string, { rows: TwseSblRow[]; expiresAt: number }>();
const CACHE_TTL = 6 * 60 * 60_000;  // 6 小時（歷史資料不變）

export interface TwseSblRow {
  date: string;          // YYYY-MM-DD
  stockId: string;
  /** 融券當日餘額（張）*/
  shortBalance: number;
  /** 融券淨變化（今日 ─ 昨日，張）*/
  shortNet: number;
  /** 融券當日新增放空（張）*/
  shortSales: number;
  /** 融券當日回補（張）*/
  shortCovering: number;
  /** 借券當日餘額（張）*/
  lendingBalance: number;
  /** 借券淨變化（今日 ─ 昨日 + 調整，張）*/
  lendingNet: number;
  /** 借券當日新增放空（張）*/
  lendingShortSales: number;
  /** 借券當日還券（張）*/
  lendingReturns: number;
  /** 借券當日調整（張）*/
  lendingAdjustments: number;
}

interface TwseResp {
  stat?: string;
  date?: string;
  fields?: string[];
  data?: Array<Array<string>>;
}

/**
 * 抓 TWSE 信用額度總量管制餘額表（一次拿全市場）
 * @param date YYYYMMDD (8 digits, no dashes)
 */
async function fetchTwseSblAll(date: string): Promise<TwseSblRow[]> {
  const cacheKey = `twse:sbl:${date}`;
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const url = `${TWSE_URL}?date=${date}&response=json`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const json: TwseResp = await res.json();
    if (json.stat !== 'OK' || !Array.isArray(json.data)) return [];

    // 日期格式 "YYYYMMDD" → "YYYY-MM-DD"
    const dateIso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const toLots = (s: string): number => {
      const n = parseInt(s.replace(/[,]/g, ''), 10);
      if (!Number.isFinite(n)) return 0;
      return Math.round(n / 1000);
    };

    const result: TwseSblRow[] = json.data.map(row => {
      const stockId = row[0];
      const shortPrev = toLots(row[2]);
      const shortSalesT = toLots(row[3]);
      const shortCoverT = toLots(row[4]);
      // const cashOffset = toLots(row[5]);  // 現券
      const shortBalance = toLots(row[6]);
      const lendingPrev = toLots(row[8]);
      const lendingSalesT = toLots(row[9]);
      const lendingReturnsT = toLots(row[10]);
      const lendingAdjT = toLots(row[11]);
      const lendingBalance = toLots(row[12]);

      return {
        date: dateIso,
        stockId,
        shortBalance,
        shortNet: shortBalance - shortPrev,
        shortSales: shortSalesT,
        shortCovering: shortCoverT,
        lendingBalance,
        lendingNet: lendingBalance - lendingPrev,
        lendingShortSales: lendingSalesT,
        lendingReturns: lendingReturnsT,
        lendingAdjustments: lendingAdjT,
      };
    });

    CACHE.set(cacheKey, { rows: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch {
    return [];
  }
}

/**
 * 取單檔股票某日 SBL 資料
 */
export async function fetchTwseSblForStock(
  stockId: string,
  dateIso: string,    // YYYY-MM-DD
): Promise<TwseSblRow | null> {
  const dateCompact = dateIso.replace(/-/g, '');
  const all = await fetchTwseSblAll(dateCompact);
  return all.find(r => r.stockId === stockId) ?? null;
}

/**
 * 抓單檔股票多日歷史（每日呼叫一次 TWSE）— 用於趨勢偵測
 */
export async function fetchTwseSblHistory(
  stockId: string,
  endDateIso: string,
  days = 30,
): Promise<TwseSblRow[]> {
  const result: TwseSblRow[] = [];
  const end = new Date(endDateIso + 'T00:00:00Z');
  for (let i = 0; i < days; i++) {
    const d = new Date(end.getTime() - i * 86400_000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;  // skip weekend
    const dateCompact = d.toISOString().slice(0, 10).replace(/-/g, '');
    const dateIso = d.toISOString().slice(0, 10);
    const all = await fetchTwseSblAll(dateCompact);
    const row = all.find(r => r.stockId === stockId);
    if (row) result.push(row);
  }
  return result.reverse();  // 升冪
}
