/**
 * TPEX 上櫃借券/融券公開資料（免費、無 quota）
 *
 * Source: POST https://www.tpex.org.tw/www/zh-tw/margin/sbl
 *   body: date=YYYY/MM/DD&response=json&type=Daily
 *   信用額度總量管制餘額表（上櫃）— 全市場單日一次回
 *
 * 欄位（tables[0].fields，與 TWSE TWT93U 同結構）：
 *   [股票代號, 股票名稱,
 *    融券前日餘額, 融券賣出, 融券買進, 融券現券, 融券當日餘額, 融券限額,
 *    借券前日餘額, 借券當日賣出, 借券當日還券, 借券當日調整數額, 借券當日餘額, 借券次一限額, 備註]
 *
 * 單位「股」→ ÷1000 換「張」。回傳與 TwseSblProvider 同 shape，方便共用。
 */

import type { TwseSblRow } from './TwseSblProvider';

const TPEX_SBL_URL = 'https://www.tpex.org.tw/www/zh-tw/margin/sbl';

const CACHE = new Map<string, { rows: TwseSblRow[]; expiresAt: number }>();
const CACHE_TTL = 6 * 60 * 60_000;

interface TpexResp {
  stat?: string;
  tables?: Array<{ data?: Array<Array<string>> }>;
}

function isoToRocSlash(iso: string): string {
  // TPEX 接受 "2026/05/27"（西元）也可，實測西元格式正常
  return iso.replace(/-/g, '/');
}

async function fetchTpexSblAll(dateIso: string): Promise<TwseSblRow[]> {
  const cacheKey = `tpex:sbl:${dateIso}`;
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  try {
    // 2026-06-12 B2：裸 fetch 被 TPEx Cloudflare 擋（TLS 指紋）→ 改 curl-first helper（POST）
    const { fetchJsonWithCurlFallback } = await import('./curlFetch');
    const { data: json } = await fetchJsonWithCurlFallback<TpexResp>(TPEX_SBL_URL, {
      proxyFirst: true,
      method: 'POST',
      body: `date=${isoToRocSlash(dateIso)}&response=json&type=Daily`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const table = json.tables?.[0];
    if (!table?.data) return [];

    const toLots = (s: string): number => {
      const n = parseInt(String(s).replace(/[,]/g, ''), 10);
      return Number.isFinite(n) ? Math.round(n / 1000) : 0;
    };

    const result: TwseSblRow[] = table.data.map(row => {
      const shortPrev = toLots(row[2]);
      const shortSalesT = toLots(row[3]);
      const shortCoverT = toLots(row[4]);
      const shortBalance = toLots(row[6]);
      const lendingPrev = toLots(row[8]);
      const lendingSalesT = toLots(row[9]);
      const lendingReturnsT = toLots(row[10]);
      const lendingAdjT = toLots(row[11]);
      const lendingBalance = toLots(row[12]);
      return {
        date: dateIso,
        stockId: row[0],
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

export async function fetchTpexSblForStock(stockId: string, dateIso: string): Promise<TwseSblRow | null> {
  const all = await fetchTpexSblAll(dateIso);
  return all.find(r => r.stockId === stockId) ?? null;
}

/** 全市場單日 bulk（/api/cron/fetch-chip-extras 每日持久化用；2026-06-12 B2）*/
export async function fetchTpexSblBulk(dateIso: string): Promise<TwseSblRow[]> {
  return fetchTpexSblAll(dateIso);
}

export async function fetchTpexSblHistory(
  stockId: string,
  endDateIso: string,
  days = 30,
): Promise<TwseSblRow[]> {
  // 並行抓（限並發 8）：原本逐日 await 串行拖垮 /api/chip（上櫃股）。fetchTpexSblAll 有日 cache + proxyFirst。2026-06-22 修。
  const end = new Date(endDateIso + 'T00:00:00Z');
  const isoDays = [...Array(days)].map((_, i) => new Date(end.getTime() - i * 86400_000))
    .filter((d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
    .map((d) => d.toISOString().slice(0, 10));
  const result: TwseSblRow[] = [];
  const CONC = 8;
  for (let i = 0; i < isoDays.length; i += CONC) {
    const batch = await Promise.all(isoDays.slice(i, i + CONC).map(async (iso) => {
      const all = await fetchTpexSblAll(iso).catch(() => []);
      return all.find((r) => r.stockId === stockId) ?? null;
    }));
    for (const row of batch) if (row) result.push(row);
  }
  return result.reverse();
}
