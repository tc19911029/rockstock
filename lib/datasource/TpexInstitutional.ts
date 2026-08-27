/**
 * TPEx 上櫃三大法人買賣超（官方、全市場單日）。
 *
 * Source:
 * https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php
 *
 * 欄位群組（每組依序為買進／賣出／買賣超）：
 *   2-4   外資及陸資（不含外資自營商）
 *   5-7   外資自營商
 *   8-10  外資合計
 *   11-13 投信
 *   14-16 自營商自行買賣
 *   17-19 自營商避險
 *   20-22 自營商合計
 *   23    三大法人合計
 */
import type { InstitutionalRecord } from './TWSEInstitutional';

const TPEX_URL = 'https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php';

interface TpexInstitutionalResponse {
  tables?: Array<{ data?: string[][] }>;
}

function isoToRocDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${Number(m[1]) - 1911}/${m[2]}/${m[3]}`;
}

function parseShares(value: unknown): number {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

/** 純解析函式，供 contract test 鎖住 TPEx 欄位位置。 */
export function parseTpexInstitutionalRows(rows: readonly string[][]): InstitutionalRecord[] {
  const records: InstitutionalRecord[] = [];
  for (const row of rows) {
    const symbol = String(row[0] ?? '').trim();
    if (!symbol) continue;
    records.push({
      symbol,
      name: String(row[1] ?? '').trim(),
      foreign: parseShares(row[10]),
      trust: parseShares(row[13]),
      dealer: parseShares(row[22]),
      total: parseShares(row[23]),
    });
  }
  return records;
}

export async function fetchTpexInstitutional(date: string): Promise<InstitutionalRecord[]> {
  const url = `${TPEX_URL}?l=zh-tw&d=${encodeURIComponent(isoToRocDate(date))}&se=EW&t=D`;
  const { fetchJsonWithCurlFallback } = await import('./curlFetch');
  const { data } = await fetchJsonWithCurlFallback<TpexInstitutionalResponse>(url, {
    proxyFirst: true,
    timeoutMs: 20_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; rockstock/2.0)' },
  });
  return parseTpexInstitutionalRows(data.tables?.[0]?.data ?? []);
}
