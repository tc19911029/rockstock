/**
 * EOD Settle — Batch Mode
 *
 * 為什麼要 batch：TWSEHistProvider.getCandlesRange(single, date, date) 每次都會
 * 拉整批 STOCK_DAY 或 MI_INDEX table（10+ 秒），不適合並行打 1000+ 檔。
 *
 * 這個 batch 模式：每日只打一次 TWSE/TPEx/EastMoney 全市場 table、cache 起來，
 * 每檔 settleSymbol 從 cache lookup。EODHD/Yahoo 仍走 per-symbol（它們是 per-symbol API）。
 */

import { fetchJsonWithCurlFallback } from './curlFetch';
import type { VendorQuote, Market } from './eodSettle';

interface BulkRow { open: number; high: number; low: number; close: number; volume: number; }

// ── TW bulk fetchers ─────────────────────────────────────────────────────────

/** TWSE MI_INDEX (上市) 全市場 OHLCV — 一次拉整天 */
export async function fetchTWSEBulkForDate(date: string): Promise<Map<string, BulkRow>> {
  const d = date.replace(/-/g, '');
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d}&type=ALLBUT0999`;
  try {
    const { data } = await fetchJsonWithCurlFallback<{ stat: string; tables: Array<{ data: string[][] }> }>(url, { timeoutMs: 30_000 });
    const map = new Map<string, BulkRow>();
    if (data.stat !== 'OK') return map;
    const table = data.tables?.[8];
    if (!table?.data?.length) return map;
    const num = (s: string) => { const n = parseFloat((s ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
    for (const row of table.data) {
      const code = row[0]?.trim();
      if (!code || !/^\d{4,}[A-Z]?$/.test(code)) continue;
      const open = num(row[5]), high = num(row[6]), low = num(row[7]), close = num(row[8]);
      const volume = Math.round(num(row[2]) / 1000);
      if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
    }
    return map;
  } catch { return new Map(); }
}

/** TPEx 上櫃 OpenAPI 全市場 OHLCV — 只回最新日（歷史日要靠 per-symbol 補）
 *
 * 2026-05-21：原 stub 直接 return new Map() 讓上櫃股 EOD settle 完全沒 TPEx 權威源，
 * 三源剩 FinMind+EODHD+Yahoo 對打，stale L1 帶歪就 settled-single-source 寫死。
 * 修補：對「今天」走 TPEx OpenAPI（一次拉 1000+ 檔），對「歷史日」仍 return empty。
 */
export async function fetchTPExBulkForDate(date: string): Promise<Map<string, BulkRow>> {
  const map = new Map<string, BulkRow>();
  try {
    // 判斷是否為「今天」(taipei)
    const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    if (date !== todayTW) {
      // 歷史日不支援；留空讓 per-symbol vendor 接手
      return map;
    }
    const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';
    const { data } = await fetchJsonWithCurlFallback<Array<{
      Date?: string; SecuritiesCompanyCode?: string;
      Open?: string; High?: string; Low?: string; Close?: string;
      TradingShares?: string;
    }>>(url, { timeoutMs: 15_000 });
    if (!Array.isArray(data)) return map;
    const num = (s: string | undefined) => {
      if (!s) return 0;
      const n = parseFloat(String(s).replace(/,/g, ''));
      return isNaN(n) ? 0 : n;
    };
    for (const row of data) {
      const code = row.SecuritiesCompanyCode?.trim();
      if (!code || !/^\d{4,6}[A-Z]?$/.test(code)) continue;
      const open = num(row.Open), high = num(row.High), low = num(row.Low), close = num(row.Close);
      // TradingShares 是「股」，/1000 變張
      const volume = Math.round(num(row.TradingShares) / 1000);
      if (close > 0 && open > 0 && high > 0 && low > 0) {
        map.set(code, { open, high, low, close, volume });
      }
    }
    return map;
  } catch {
    return map;
  }
}

// ── CN bulk fetchers ─────────────────────────────────────────────────────────

/** EastMoney 全市場一日 OHLCV — push2his/get_klines */
export async function fetchEastMoneyBulkForDate(date: string): Promise<Map<string, BulkRow>> {
  // EastMoney 沒有「全市場某日」端點，每檔要單拉。
  // 此處 stub 留 future：可改用清華 stock list + 並行拉，但比 per-symbol 慢
  return new Map();
}

// ── Vendor cache 介面 ───────────────────────────────────────────────────────

export interface VendorBatchCache {
  market: Market;
  date: string;
  twseBulk: Map<string, BulkRow>;     // TW 上市 (code without suffix)
  tpexBulk: Map<string, BulkRow>;     // TW 上櫃 (code without suffix)
  eastMoneyBulk: Map<string, BulkRow>; // CN (code without suffix)
}

export async function prefetchVendorBatch(market: Market, date: string): Promise<VendorBatchCache> {
  if (market === 'TW') {
    const [twse, tpex] = await Promise.all([
      fetchTWSEBulkForDate(date),
      fetchTPExBulkForDate(date),
    ]);
    return { market, date, twseBulk: twse, tpexBulk: tpex, eastMoneyBulk: new Map() };
  } else {
    return { market, date, twseBulk: new Map(), tpexBulk: new Map(), eastMoneyBulk: new Map() };
  }
}

export function lookupBulkQuote(cache: VendorBatchCache, symbol: string, market: Market): VendorQuote | null {
  const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  let row: BulkRow | undefined;
  let vendor: string | undefined;
  if (market === 'TW') {
    if (symbol.endsWith('.TWO')) {
      row = cache.tpexBulk.get(code);
      vendor = 'TPEx';
    } else {
      row = cache.twseBulk.get(code);
      vendor = 'TWSE';
    }
    // 上市/上櫃 fallback 互查（部分 ETF 混在不同表）
    if (!row) {
      row = cache.twseBulk.get(code) ?? cache.tpexBulk.get(code);
      vendor = cache.twseBulk.has(code) ? 'TWSE' : 'TPEx';
    }
  } else {
    row = cache.eastMoneyBulk.get(code);
    vendor = 'EastMoney';
  }
  if (!row) return null;
  return { vendor: vendor!, ...row };
}
