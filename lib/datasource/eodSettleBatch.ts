/**
 * EOD Settle — Batch Mode
 *
 * 為什麼要 batch：TWSEHistProvider.getCandlesRange(single, date, date) 每次都會
 * 拉整批 STOCK_DAY 或 MI_INDEX table（10+ 秒），不適合並行打 1000+ 檔。
 *
 * 這個 batch 模式：每日只打一次 TWSE/TPEx/EastMoney 全市場 table、cache 起來，
 * 每檔 settleSymbol 從 cache lookup。EODHD/Yahoo 仍走 per-symbol（它們是 per-symbol API）。
 */

import { fetchJsonWithCurlFallback, fetchTextWithCurlFallback } from './curlFetch';
import type { VendorQuote, Market } from './eodSettle';

interface BulkRow { open: number; high: number; low: number; close: number; volume: number; }

// ── TW bulk fetchers ─────────────────────────────────────────────────────────

/** TWSE MI_INDEX (上市) 全市場 OHLCV — 一次拉整天
 *
 * 2026-07-29：MI_INDEX 在機器塞爆時間歇回空（tables[8] 抓不到）→ 全部上市股掉到逐檔
 * FinMind，FinMind 免費層 600/日一下 402 → 569 檔（含 2330/0050）變 pending-no-vendor-data。
 * 修法：MI_INDEX 回空時 fallback 到 STOCK_DAY_ALL（同為 TWSE 官方整批、塞爆時仍活），
 * 不改 provider 路由策略，只加同源冗餘（比照 TPEx 已有的 curl fallback）。
 */
export async function fetchTWSEBulkForDate(date: string): Promise<Map<string, BulkRow>> {
  const d = date.replace(/-/g, '');
  const url = `https://wwwc.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d}&type=ALLBUT0999`;
  let map = new Map<string, BulkRow>();
  try {
    const { data } = await fetchJsonWithCurlFallback<{ stat: string; tables: Array<{ fields?: string[]; data: string[][] }> }>(url, { timeoutMs: 30_000 });
    if (data.stat !== 'OK') { console.warn(`[eodSettleBatch] TWSE MI_INDEX ${date} stat=${data.stat}（資料未發布或日期錯）`); }
    else {
      const idxOf = (fields: string[], ...names: string[]) =>
        fields.findIndex(f => names.includes(f.replace(/\s/g, '')));
      const table = data.tables?.find(t => {
        const fields = t.fields ?? [];
        return idxOf(fields, '證券代號') >= 0 && idxOf(fields, '收盤價') >= 0 && t.data?.length > 100;
      });
      if (!table?.data?.length) { console.warn(`[eodSettleBatch] TWSE MI_INDEX ${date} 找不到每日收盤行情表`); }
      else {
        const num = (s: string) => { const n = parseFloat((s ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
        const fields = table.fields ?? [];
        const cCode = idxOf(fields, '證券代號');
        const cOpen = idxOf(fields, '開盤價');
        const cHigh = idxOf(fields, '最高價');
        const cLow = idxOf(fields, '最低價');
        const cClose = idxOf(fields, '收盤價');
        const cVolume = idxOf(fields, '成交股數');
        if ([cCode, cOpen, cHigh, cLow, cClose, cVolume].some(i => i < 0)) {
          throw new Error(`TWSE MI_INDEX 欄位缺失 fields=${JSON.stringify(fields)}`);
        }
        for (const row of table.data) {
          const code = row[cCode]?.trim();
          if (!code || !/^\d{4,}[A-Z]?$/.test(code)) continue;
          const open = num(row[cOpen]), high = num(row[cHigh]), low = num(row[cLow]), close = num(row[cClose]);
          const volume = Math.round(num(row[cVolume]) / 1000);
          if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
        }
      }
    }
  } catch (e) {
    console.warn(`[eodSettleBatch] TWSE MI_INDEX ${date} 抓取失敗: ${(e as Error).message}`);
  }
  // MI_INDEX 回空 → 備援 STOCK_DAY_ALL（官方整批 CSV，塞爆時仍活）
  if (map.size === 0) {
    const fallback = await fetchTWSEStockDayAll(date);
    if (fallback.size > 0) { console.warn(`[eodSettleBatch] TWSE MI_INDEX ${date} 空 → STOCK_DAY_ALL 備援補 ${fallback.size} 檔`); map = fallback; }
  }
  return map;
}

/** TWSE STOCK_DAY_ALL（個股當日成交，CSV）— MI_INDEX 的整批備援源
 *
 * ⚠️ 此端點只出「最新交易日」、無 date 參數 → 用 feed 自帶的民國日比對，
 * 只有 feed 日 === 要封的 date 才採用（防歷史回填被今天資料污染，比照 TPEx bulk 守衛）。
 */
export async function fetchTWSEStockDayAll(date: string): Promise<Map<string, BulkRow>> {
  const map = new Map<string, BulkRow>();
  try {
    const url = 'https://wwwc.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json';
    const { text } = await fetchTextWithCurlFallback(url, {
      timeoutMs: 20_000,
      proxyFirst: true, // TWSE 是台灣站，中國線路走代理優先
      validate: (t) => t.includes('證券代號'),
    });
    if (!text || !text.includes('證券代號')) { console.warn(`[eodSettleBatch] STOCK_DAY_ALL ${date} 回應非預期 → 備援空`); return map; }
    const num = (s: string | undefined) => { const n = parseFloat((s ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
    let feedDate: string | null = null;
    for (const line of text.split('\n')) {
      // 每欄都被雙引號包住 → 抽出所有引號內字串當欄位
      const cells = (line.match(/"([^"]*)"/g) || []).map(c => c.slice(1, -1));
      if (cells.length < 9) continue;
      const roc = cells[0]?.trim();
      if (!/^\d{7}$/.test(roc)) continue;
      if (!feedDate) feedDate = rocDateToAd(roc);
      const code = cells[1]?.trim();
      if (!code || !/^\d{4,}[A-Z]?$/.test(code)) continue;
      const open = num(cells[5]), high = num(cells[6]), low = num(cells[7]), close = num(cells[8]);
      const volume = Math.round(num(cells[3]) / 1000); // 成交股數 → 張
      if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
    }
    if (feedDate && feedDate !== date) {
      console.warn(`[eodSettleBatch] STOCK_DAY_ALL feed 日=${feedDate} ≠ 要封 ${date}（只出最新交易日）→ 備援不採用`);
      return new Map();
    }
    return map;
  } catch (e) {
    console.warn(`[eodSettleBatch] STOCK_DAY_ALL ${date} 抓取失敗: ${(e as Error).message} → 備援空`);
    return map;
  }
}

/** 民國日期 "1150609" / "115/06/09" → 西元 "2026-06-09"。 */
export function rocDateToAd(roc: string | undefined): string | null {
  if (!roc) return null;
  const s = roc.trim().replaceAll('/', '');
  if (!/^\d{7}$/.test(s)) return null;
  const y = parseInt(s.slice(0, 3), 10) + 1911;
  return `${y}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
}

type TPExDatedCloseResponse = {
  stat?: string;
  tables?: Array<{ date?: string; fields?: string[]; data?: string[][] }>;
};

/** 解析 TPEx 可指定日期的「上櫃股票每日收盤行情」官方表。 */
export function parseTPExDatedCloseResponse(
  payload: TPExDatedCloseResponse,
  date: string,
): Map<string, BulkRow> {
  const out = new Map<string, BulkRow>();
  const normalizeField = (value: string) => value.replace(/<[^>]*>/g, '').replace(/\s/g, '');
  const table = payload.tables?.find(candidate => {
    const fields = candidate.fields?.map(normalizeField) ?? [];
    return fields.includes('代號') && fields.includes('收盤') && (candidate.data?.length ?? 0) > 100;
  });
  if (!table || rocDateToAd(table.date) !== date) return out;

  const fields = (table.fields ?? []).map(normalizeField);
  const index = (name: string) => fields.indexOf(name);
  const cCode = index('代號');
  const cClose = index('收盤');
  const cOpen = index('開盤');
  const cHigh = index('最高');
  const cLow = index('最低');
  const cVolume = index('成交股數');
  if ([cCode, cClose, cOpen, cHigh, cLow, cVolume].some(value => value < 0)) return out;

  const num = (value: string | undefined) => {
    const parsed = parseFloat((value ?? '').replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  for (const row of table.data ?? []) {
    const code = row[cCode]?.trim();
    if (!code || !/^\d{4,6}[A-Z]?$/.test(code)) continue;
    const open = num(row[cOpen]);
    const high = num(row[cHigh]);
    const low = num(row[cLow]);
    const close = num(row[cClose]);
    const volume = Math.round(num(row[cVolume]) / 1000);
    if (open > 0 && high > 0 && low > 0 && close > 0) {
      out.set(code, { open, high, low, close, volume });
    }
  }
  return out;
}

/**
 * TPEx latest OpenAPI 常比收盤表晚更新；指定日期的官方表已到時可立即定稿，
 * 不必因 latest feed 仍停在上一交易日而延後全市場 L1。
 */
async function fetchTPExDatedBulkForDate(date: string): Promise<Map<string, BulkRow>> {
  try {
    const formattedDate = encodeURIComponent(date.replaceAll('-', '/'));
    const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${formattedDate}&type=EW&response=json`;
    const { data } = await fetchJsonWithCurlFallback<TPExDatedCloseResponse>(url, {
      timeoutMs: 30_000,
      proxyFirst: true,
    });
    const parsed = parseTPExDatedCloseResponse(data, date);
    console.log(`[eodSettleBatch] TPEx 指定日期官方收盤表 ${date}: ${parsed.size} 筆`);
    return parsed;
  } catch (error) {
    console.warn(`[eodSettleBatch] TPEx 指定日期官方收盤表 ${date} 抓取失敗: ${(error as Error).message}`);
    return new Map();
  }
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
    if (!Array.isArray(data) || data.length === 0) {
      console.warn(`[eodSettleBatch] TPEx quotes ${date} 回空陣列 → 改讀指定日期官方收盤表`);
    } else {
      // feed 帶自己的交易日；只在 feed 日 === 要封的 date 時採用（避免盤中跑、或拿錯日資料）
      const feedDate = rocDateToAd(data.find(r => r.Date)?.Date);
      if (!feedDate || feedDate !== date) {
        console.warn(`[eodSettleBatch] TPEx quotes feed 日=${feedDate} ≠ 要封 ${date}（資料未更新）→ 改讀指定日期官方收盤表`);
      } else {
        const num = (s: string | undefined) => {
          if (!s) return 0;
          const n = parseFloat(String(s).replace(/,/g, ''));
          return isNaN(n) ? 0 : n;
        };
        for (const row of data) {
          const code = row.SecuritiesCompanyCode?.trim();
          if (!code || !/^\d{4,6}[A-Z]?$/.test(code)) continue;
          const open = num(row.Open);
          const high = num(row.High);
          const low = num(row.Low);
          const close = num(row.Close);
          // TradingShares 是「股」，/1000 變張
          const volume = Math.round(num(row.TradingShares) / 1000);
          if (close > 0 && open > 0 && high > 0 && low > 0) {
            map.set(code, { open, high, low, close, volume });
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[eodSettleBatch] TPEx quotes ${date} 抓取失敗: ${(e as Error).message} → 改讀指定日期官方收盤表`);
  }
  if (map.size >= 900) return map;
  const dated = await fetchTPExDatedBulkForDate(date);
  return dated.size > map.size ? dated : map;
}

// ── CN bulk fetchers ─────────────────────────────────────────────────────────

/** EastMoney 全市場一日 OHLCV — push2his/get_klines */
export async function fetchEastMoneyBulkForDate(_date: string): Promise<Map<string, BulkRow>> {
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
