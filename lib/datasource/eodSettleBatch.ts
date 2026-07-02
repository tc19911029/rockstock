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
    if (data.stat !== 'OK') { console.warn(`[eodSettleBatch] TWSE MI_INDEX ${date} stat=${data.stat}（資料未發布或日期錯）→ bulk 空`); return map; }
    const table = data.tables?.[8];
    if (!table?.data?.length) { console.warn(`[eodSettleBatch] TWSE MI_INDEX ${date} tables[8] 空 → bulk 空`); return map; }
    const num = (s: string) => { const n = parseFloat((s ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
    for (const row of table.data) {
      const code = row[0]?.trim();
      if (!code || !/^\d{4,}[A-Z]?$/.test(code)) continue;
      const open = num(row[5]), high = num(row[6]), low = num(row[7]), close = num(row[8]);
      const volume = Math.round(num(row[2]) / 1000);
      if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
    }
    return map;
  } catch (e) {
    console.warn(`[eodSettleBatch] TWSE MI_INDEX ${date} 抓取失敗: ${(e as Error).message} → bulk 空`);
    return new Map();
  }
}

/** 民國日期 "1150609" → 西元 "2026-06-09"（feed 的 Date 欄位格式） */
function rocDateToAd(roc: string | undefined): string | null {
  if (!roc) return null;
  const s = roc.trim();
  if (!/^\d{7}$/.test(s)) return null;
  const y = parseInt(s.slice(0, 3), 10) + 1911;
  return `${y}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
}

/** TPEx 上櫃 OpenAPI 全市場 OHLCV — 一次拉 1000+ 檔（上櫃官方權威源）
 *
 * 2026-05-21：原 stub return new Map() 讓上櫃 EOD settle 完全沒 TPEx 權威源。
 * 2026-06-09 修真正的 bug：原本用 `date !== todayTW(日曆今天)` 當 gate，但盤後封存
 * 常在隔天 00:xx 才跑（封昨日），那時 todayTW 已滾到今天 → date(昨)≠todayTW → 整個
 * TPEx 被擋掉回空 → 上櫃只剩 FinMind 當唯一錨，FinMind 一 402 就退 Yahoo 中間價 →
 * 次檔位守衛擋下 → 卡關/污染（124 檔卡 06-05 + 28 根中間價假收盤的根因）。
 * 改用 feed 自己帶的交易日（Date 欄，民國 yyyMMdd）比對：feed 日 === 要封的 date 才採用，
 * 否則留空讓 per-symbol vendor 接手（歷史日 feed 沒有 → 自動退讓，行為正確）。
 */
export async function fetchTPExBulkForDate(date: string): Promise<Map<string, BulkRow>> {
  const map = new Map<string, BulkRow>();
  try {
    const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';
    const { data } = await fetchJsonWithCurlFallback<Array<{
      Date?: string; SecuritiesCompanyCode?: string;
      Open?: string; High?: string; Low?: string; Close?: string;
      TradingShares?: string;
    }>>(url, { timeoutMs: 15_000 });
    if (!Array.isArray(data) || data.length === 0) { console.warn(`[eodSettleBatch] TPEx quotes ${date} 回空陣列 → bulk 空`); return map; }
    // feed 帶自己的交易日；只在 feed 日 === 要封的 date 時採用（避免盤中跑、或拿錯日資料）
    const feedDate = rocDateToAd(data.find(r => r.Date)?.Date);
    if (!feedDate || feedDate !== date) { console.warn(`[eodSettleBatch] TPEx quotes feed 日=${feedDate} ≠ 要封 ${date}（資料未更新）→ bulk 空`); return map; }
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
  } catch (e) {
    console.warn(`[eodSettleBatch] TPEx quotes ${date} 抓取失敗: ${(e as Error).message} → bulk 空`);
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
