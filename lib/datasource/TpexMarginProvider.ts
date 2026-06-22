/**
 * TPEX 上櫃融資融券公開資料（免費、無 quota）
 *
 * Source: https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&d=YYY/MM/DD&se=AL
 *   日期格式：民國年/月/日（例 115/05/27 = 2026-05-27）
 *
 * 欄位（tables[0].fields）：
 *   [代號, 名稱,
 *    前資餘額(張), 資買, 資賣, 現償, 資餘額, 資屬證金, 資使用率(%), 資限額,
 *    前券餘額(張), 券賣, 券買, 券償, 券餘額, 券屬證金, 券使用率(%), 券限額,
 *    資券相抵(張), 備註]
 *
 * 借券（SBL）TPEX endpoint 隱藏中，目前不支援；上櫃股 lendingBalance 會為 0。
 */

const TPEX_URL = 'https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php';

const CACHE = new Map<string, { rows: TpexMarginRow[]; expiresAt: number }>();
const CACHE_TTL = 6 * 60 * 60_000;

export interface TpexMarginRow {
  date: string;
  stockId: string;
  marginBalance: number;
  marginNet: number;
  marginUtilRate: number;
  shortBalance: number;
  shortNet: number;
}

interface TpexResp {
  date?: string;
  tables?: Array<{ data?: Array<Array<string>>; totalCount?: number }>;
}

/** "2026-05-27" → "115/05/27" */
function isoToRocDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const roc = parseInt(m[1], 10) - 1911;
  return `${roc}/${m[2]}/${m[3]}`;
}

async function fetchTpexMarginAll(dateIso: string): Promise<TpexMarginRow[]> {
  const cacheKey = `tpex:margin:${dateIso}`;
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const rocDate = isoToRocDate(dateIso);
  const url = `${TPEX_URL}?l=zh-tw&d=${rocDate}&se=AL`;
  try {
    // 2026-06-12 B2：裸 fetch 被 TPEx Cloudflare 擋（TLS 指紋）→ 改 curl-first helper
    const { fetchJsonWithCurlFallback } = await import('./curlFetch');
    const { data: json } = await fetchJsonWithCurlFallback<TpexResp>(url, { proxyFirst: true });
    const table = json.tables?.[0];
    if (!table?.data) return [];

    const toNum = (s: string): number => {
      const n = parseInt(s.replace(/[,]/g, ''), 10);
      return Number.isFinite(n) ? n : 0;
    };

    const result: TpexMarginRow[] = table.data.map(row => {
      const marginPrev = toNum(row[2]);
      const marginCur = toNum(row[6]);
      const marginUtilRate = parseFloat((row[8] || '0').replace(/[,]/g, '')) || 0;
      const shortPrev = toNum(row[10]);
      const shortCur = toNum(row[14]);
      return {
        date: dateIso,
        stockId: row[0],
        marginBalance: marginCur,
        marginNet: marginCur - marginPrev,
        marginUtilRate,
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

export async function fetchTpexMarginForStock(stockId: string, dateIso: string): Promise<TpexMarginRow | null> {
  const all = await fetchTpexMarginAll(dateIso);
  return all.find(r => r.stockId === stockId) ?? null;
}

/** 全市場單日 bulk（/api/cron/fetch-chip-extras 每日持久化用；2026-06-12 B2）*/
export async function fetchTpexMarginBulk(dateIso: string): Promise<TpexMarginRow[]> {
  return fetchTpexMarginAll(dateIso);
}
