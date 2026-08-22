/**
 * EastMoney 日K / 股票清單 datasource — 日K 重建回填路徑專用
 *
 * 為什麼不用 lib/datasource/EastMoneyHistProvider：
 *   1. 它的 fetchEMKlines 是 module-private、走純 Node fetch — 本機對
 *      push2his 直連常被 TLS reset（2026-06-12 實測 node fetch 失敗、
 *      curlFetch 的 curl+本機代理 fallback 可通），回填腳本要走
 *      fetchJsonWithCurlFallback 才跑得完
 *   2. 它回 CandleWithIndicators（computeIndicators 開銷）+ globalCache +
 *      rateLimiter，重建回填 2000+ 檔逐檔抓不需要這些
 *
 * host 選擇（2026-06-12 實測）：
 *   - push2his.eastmoney.com（日K）：node fetch 失敗 → curl fallback 可通
 *   - push2.eastmoney.com（clist）：本機常 502（見 MEMORY data_sources_cn_quote）
 *     → 改用 push2delay.eastmoney.com（延時行情鏡像，node fetch 直連可通；
 *     我們只要代號+名稱+行業這種非時效欄位，延時無妨）；pz 上限 100 → 翻頁
 *
 * klines CSV 欄位（與 EastMoneyHistProvider 檔頭一致，實測確認）：
 *   [0]date [1]open [2]close [3]high [4]low [5]volume(手) [6]amount(元)
 *   [7]amplitude% [8]pct% [9]chg [10]turnover%
 *   注意 close 在 [2]、high 在 [3]（非標準 OHLC 順序）
 *
 * fqt=1（前復權）：與 L1 主板日K 對齊 — L1 由 Tencent qfq / EM fqt=1 寫入
 * （EastMoneyHistProvider 全域用 fqt=1、repair-cn-unadjusted-splice 用
 * Tencent qfq），重建的漲停判定兩邊同一復權基準才能在邊界日無縫接合。
 */

import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';
import { TENCENT_FQKLINE_BASES } from '@/lib/datasource/tencentKlineHosts';
import { UNRESOLVED_STOCK_NAME } from '@/lib/stocks/stockIdentity';
import type { BackfillSeriesBar, BackfillSymbolMeta } from '../backfillPools';

const EM_REFERER = 'https://quote.eastmoney.com/';
const CLIST_HOST = 'https://push2delay.eastmoney.com';
const KLINE_HOST = 'https://push2his.eastmoney.com';
const CLIST_PAGE_SIZE = 100; // 實測 pz>100 仍只回 100
const CLIST_MAX_PAGES = 40; // 防 total 異常大造成無限翻頁
const CLIST_PAGE_THROTTLE_MS = 300;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 創業板 / 科創板 股票清單（clist） ────────────────────────────────────────

interface ClistResponse {
  data?: {
    total?: number;
    diff?: Array<{ f12?: string | number; f14?: string | null; f100?: string | null }>;
  } | null;
}

type GrowthBoard = 'ChiNext' | 'STAR';

/** fs 篩選參數：創業板 m:0+t:80、科創板 m:1+t:23（EM 官方板塊代碼） */
const GROWTH_BOARD_FS: Record<GrowthBoard, { fs: string; suffix: 'SZ' | 'SS' }> = {
  ChiNext: { fs: 'm:0+t:80', suffix: 'SZ' },
  STAR: { fs: 'm:1+t:23', suffix: 'SS' },
};

async function fetchClistPage(fs: string, pn: number): Promise<ClistResponse['data']> {
  const url =
    `${CLIST_HOST}/api/qt/clist/get` +
    `?pn=${pn}&pz=${CLIST_PAGE_SIZE}&po=0&np=1&fltt=2&invt=2` +
    `&fid=f12&fs=${fs}&fields=f12,f14,f100`;
  const { data } = await fetchJsonWithCurlFallback<ClistResponse>(url, {
    headers: { Referer: EM_REFERER },
    timeoutMs: 15000,
  });
  return data?.data ?? null;
}

/**
 * 抓單一成長板全部代號（po=0 + fid=f12 按代碼升冪 → 翻頁順序穩定）。
 * 回傳 symbol 帶交易所後綴（300xxx.SZ / 688xxx.SS），與 L1 命名一致。
 */
async function fetchGrowthBoard(board: GrowthBoard): Promise<BackfillSymbolMeta[]> {
  const { fs, suffix } = GROWTH_BOARD_FS[board];
  const out: BackfillSymbolMeta[] = [];
  let total = Infinity;
  for (let pn = 1; pn <= CLIST_MAX_PAGES && out.length < total; pn++) {
    if (pn > 1) await sleep(CLIST_PAGE_THROTTLE_MS);
    const page = await fetchClistPage(fs, pn);
    const rows = page?.diff ?? [];
    if (typeof page?.total === 'number' && page.total > 0) total = page.total;
    if (rows.length === 0) break;
    for (const r of rows) {
      const code = String(r.f12 ?? '').padStart(6, '0');
      if (!/^\d{6}$/.test(code)) continue;
      out.push({
        symbol: `${code}.${suffix}`,
        name: r.f14?.trim() || UNRESOLVED_STOCK_NAME,
        industry: r.f100 ?? null,
      });
    }
  }
  if (out.length === 0) {
    throw new Error(`emDailyKlines: ${board} clist 回 0 檔 — 上游退化或 fs 參數失效`);
  }
  return out;
}

/** 創業板 + 科創板 全代號（caller 負責 7 天 TTL 快取到 _backfill-meta/） */
export async function fetchGrowthBoardSymbols(): Promise<{
  chiNext: BackfillSymbolMeta[];
  star: BackfillSymbolMeta[];
}> {
  const chiNext = await fetchGrowthBoard('ChiNext');
  await sleep(CLIST_PAGE_THROTTLE_MS);
  const star = await fetchGrowthBoard('STAR');
  return { chiNext, star };
}

// ── 日K（push2his kline） ─────────────────────────────────────────────────────

interface EmKlineResponse {
  data?: { code?: string; name?: string; klines?: string[] } | null;
}

export interface EmDailyBar extends BackfillSeriesBar {
  /** 成交額（元）；指數 K 的 amount = 全市場成交額 */
  amountCny: number | null;
}

/** 完整代號（'300001.SZ' / '688001.SS'）→ EM secid；指數用 caller 自帶 secid */
export function cnSymbolToSecid(symbol: string): string {
  const m = symbol.match(/^(\d{6})\.(SS|SZ)$/i);
  if (!m) throw new Error(`emDailyKlines: 非法 symbol '${symbol}'（要 6碼.SS/.SZ）`);
  return `${m[2].toUpperCase() === 'SS' ? 1 : 0}.${m[1]}`;
}

/**
 * 抓某 secid 的前復權日K（fqt=1，理由見檔頭）。
 * beg/end = YYYYMMDD。回升冪序列；EM 回空（新股上市前 / 代號錯）→ []。
 */
export async function fetchEmDailyBars(
  secid: string,
  begYmd8: string,
  endYmd8: string,
): Promise<EmDailyBar[]> {
  const url =
    `${KLINE_HOST}/api/qt/stock/kline/get` +
    `?secid=${secid}` +
    `&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=1&beg=${begYmd8}&end=${endYmd8}`;
  const { data } = await fetchJsonWithCurlFallback<EmKlineResponse>(url, {
    headers: { Referer: EM_REFERER },
    timeoutMs: 20000,
  });
  const out: EmDailyBar[] = [];
  for (const line of data?.data?.klines ?? []) {
    const f = line.split(',');
    if (f.length < 7) continue;
    const open = parseFloat(f[1]);
    const close = parseFloat(f[2]); // close 在 [2]、high 在 [3]（見檔頭）
    const high = parseFloat(f[3]);
    const low = parseFloat(f[4]);
    const amount = parseFloat(f[6]);
    if (!Number.isFinite(close) || close <= 0) continue;
    out.push({
      date: f[0],
      open,
      high,
      low,
      close,
      amountCny: Number.isFinite(amount) ? amount : null,
    });
  }
  return out;
}

// ── Tencent qfq 日K（批量回填主源） ──────────────────────────────────────────
//
// 2026-06-12 實測：push2his 對「批量逐檔抓」會整批 TLS reset（輕量呼叫如指數
// 2 發可通，數百發起被掐；連本機代理出口都封）。Tencent ifzq 同時段 200 正常，
// 且 Tencent qfq 本來就是本 repo CN 除權息修復的可信源（MEMORY
// cn_unadjusted_ex_date_splice — repair 用 Tencent qfq 整段取代）。
// 批量回填 K 線 Tencent 為主、EM 為備援；amount 欄 Tencent 不給 → null
//（個股 amount 重建路用不到，兩市成交額另走 EM 指數 K 輕量呼叫）。

interface TencentKlineResponse {
  code?: number;
  data?: Record<string, { qfqday?: unknown[][]; day?: unknown[][] } | undefined> | null;
}

/** 完整代號（'300001.SZ' / '000001.SS'）→ Tencent 代碼（sz300001 / sh000001） */
export function cnSymbolToTencentCode(symbol: string): string {
  const m = symbol.match(/^(\d{6})\.(SS|SZ)$/i);
  if (!m) throw new Error(`emDailyKlines: 非法 symbol '${symbol}'（要 6碼.SS/.SZ）`);
  return `${m[2].toUpperCase() === 'SS' ? 'sh' : 'sz'}${m[1]}`;
}

const ymd8ToDash = (ymd8: string): string =>
  `${ymd8.slice(0, 4)}-${ymd8.slice(4, 6)}-${ymd8.slice(6, 8)}`;

/**
 * Tencent 前復權日K。row 格式 [date, open, close, high, low, volume]
 * （open/close/high/low 順序與 EM 同款的非標準排列；無 amount）。
 * 無 qfq 調整的股票回 data[code].day。回空（新股/代號錯）→ []。
 */
export async function fetchTencentDailyBars(
  symbol: string,
  begYmd8: string,
  endYmd8: string,
): Promise<EmDailyBar[]> {
  const code = cnSymbolToTencentCode(symbol);
  // count 給足窗口上限（2 年日線 < 520 根，給 800 留裕度）
  const query = `?param=${code},day,${ymd8ToDash(begYmd8)},${ymd8ToDash(endYmd8)},800,qfq`;
  // 主網域 web.ifzq 對 CN 代號被 WAF 封(501) → 鏡像優先、舊網域 fallback（見 tencentKlineHosts）。只換 host。
  let stock: { qfqday?: unknown[][]; day?: unknown[][] } | undefined;
  for (const base of TENCENT_FQKLINE_BASES) {
    const { data } = await fetchJsonWithCurlFallback<TencentKlineResponse>(base + query, {
      timeoutMs: 15000,
    });
    stock = data?.data?.[code];
    if ((stock?.qfqday?.length ?? 0) > 0 || (stock?.day?.length ?? 0) > 0) break;
  }
  const rows = stock?.qfqday ?? stock?.day ?? [];
  const out: EmDailyBar[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const date = String(row[0]);
    const open = parseFloat(String(row[1]));
    const close = parseFloat(String(row[2])); // close 在 [2]、high 在 [3]
    const high = parseFloat(String(row[3]));
    const low = parseFloat(String(row[4]));
    if (!Number.isFinite(close) || close <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({ date, open, high, low, close, amountCny: null });
  }
  return out;
}

// ── 兩市成交額（指數日K amount 欄相加） ──────────────────────────────────────

/**
 * date → 兩市成交額（元）= 上證指數(1.000001) amount + 深證成指(0.399001) amount。
 *
 * EM 指數 K 的 amount = 該交易所「全市場」成交額（2026-06-12 實測：
 * 399001 深證成指 與 399106 深證綜指 的 amount 完全相同 → 不是成分股口徑），
 * 與線上 cnMarketBreadth 的 ulist f6（1.000001+0.399001）同源同口徑，
 * 邊界日兩路數字可直接相接。一次抓整窗，只在兩邊都有值的日期收錄。
 */
export async function fetchShSzTurnoverMap(
  begYmd8: string,
  endYmd8: string,
): Promise<Map<string, number>> {
  const sh = await fetchEmDailyBars('1.000001', begYmd8, endYmd8);
  await sleep(CLIST_PAGE_THROTTLE_MS);
  const sz = await fetchEmDailyBars('0.399001', begYmd8, endYmd8);
  const szByDate = new Map(sz.map((b) => [b.date, b.amountCny]));
  const out = new Map<string, number>();
  for (const b of sh) {
    const a = b.amountCny;
    const c = szByDate.get(b.date);
    if (a != null && c != null) out.set(b.date, a + c);
  }
  return out;
}
