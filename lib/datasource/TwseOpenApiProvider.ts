/**
 * TWSE OpenAPI Provider — 補 FinMind 免費版抓不到的 EPS / 月營收 YoY / 淨利率
 *
 * 來源（純 JSON GET、無 referer、無 Big5）：
 *   - t187ap14_L：上市季財報（基本 EPS、營業收入、營業利益、稅後淨利）
 *   - t187ap05_L：上市月營收（直接給 YoY% / MoM% / 累計 YoY）
 *
 * 上櫃對應 endpoint 在 TPEx domain：
 *   - https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap14_O
 *   - https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O
 *
 * 策略：全市場一次抓回（~1070 筆），cache 24h / 6h；per-code 從 cache 取。
 * 避免每檔個別 GET → 1070 倍 API call。
 */

const TWSE_BASE = 'https://openapi.twse.com.tw/v1/opendata';
const TPEX_BASE = 'https://www.tpex.org.tw/openapi/v1';

const TTL_QUARTERLY = 24 * 60 * 60 * 1000;   // 24h（季財報每季更新）
const TTL_MONTHLY   = 6 * 60 * 60 * 1000;    // 6h（月營收每月 10 號公告）
const TTL_FAILURE   = 5 * 60 * 1000;          // 5m（避免上游故障時每批股票重試）

// ── Types ────────────────────────────────────────────────────────────────────

export interface TwseQuarterly {
  /** 民國年 (eg 115) */
  rocYear: number;
  /** 季別 1-4 */
  season: number;
  code: string;
  industry: string;
  /** 基本每股盈餘（元）*/
  eps: number | null;
  /** 營業收入（千元）*/
  revenue: number | null;
  /** 營業利益（千元）*/
  operatingIncome: number | null;
  /** 稅後淨利（千元）*/
  netIncome: number | null;
  /** 淨利率 % = 稅後淨利 / 營業收入 */
  netMargin: number | null;
  /** 營業利益率 % = 營業利益 / 營業收入 */
  operatingMargin: number | null;
}

export interface TwseMonthly {
  /** 資料年月 ROC 格式 e.g. "11504" */
  yearMonth: string;
  code: string;
  /** 當月營收（千元）*/
  revenue: number | null;
  /** 去年同月 YoY % */
  revenueYoY: number | null;
  /** 上月比較 MoM % */
  revenueMoM: number | null;
  /** 累計 YoY % */
  cumRevenueYoY: number | null;
}

export interface TwCompanyProfile {
  code: string;
  name: string;
  industry: string;
  issuedShares: number | null;
  marketType: 'twse' | 'tpex';
}

// ── In-memory cache（單 entry 存整個 map）───────────────────────────────────

interface CacheEntry<T> { data: T; expiresAt: number; }

let quarterlyCache: CacheEntry<Map<string, TwseQuarterly>> | null = null;
let monthlyCache:   CacheEntry<Map<string, TwseMonthly>> | null = null;
let quarterlyInflight: Promise<Map<string, TwseQuarterly>> | null = null;
let monthlyInflight:   Promise<Map<string, TwseMonthly>> | null = null;
let companyCache: CacheEntry<Map<string, TwCompanyProfile>> | null = null;
let companyInflight: Promise<Map<string, TwCompanyProfile>> | null = null;

// ── Parsing helpers ──────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[,\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === 'N/A') return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ── Quarterly (t187ap14_L) ──────────────────────────────────────────────────

interface QuarterlyRow {
  '出表日期'?: string;
  '年度'?: string;
  '季別'?: string;
  '公司代號'?: string;
  '公司名稱'?: string;
  '產業別'?: string;
  '基本每股盈餘(元)'?: string;
  '營業收入'?: string;
  '營業利益'?: string;
  '稅後淨利'?: string;
}

async function fetchQuarterlyMap(): Promise<Map<string, TwseQuarterly>> {
  if (quarterlyCache && Date.now() < quarterlyCache.expiresAt) return quarterlyCache.data;
  if (quarterlyInflight) return quarterlyInflight;

  quarterlyInflight = (async () => {
    const res = await fetch(`${TWSE_BASE}/t187ap14_L`, {
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
      headers: { 'User-Agent': 'rockstock/1.0' },
    });
    if (!res.ok) throw new Error(`TWSE t187ap14_L HTTP ${res.status}`);
    const rows = await res.json() as QuarterlyRow[];

    const map = new Map<string, TwseQuarterly>();
    for (const r of rows) {
      const code = r['公司代號']?.trim();
      if (!code) continue;
      const revenue = toNum(r['營業收入']);
      const opIncome = toNum(r['營業利益']);
      const netIncome = toNum(r['稅後淨利']);
      const netMargin = revenue != null && revenue > 0 && netIncome != null
        ? +(netIncome / revenue * 100).toFixed(2) : null;
      const opMargin = revenue != null && revenue > 0 && opIncome != null
        ? +(opIncome / revenue * 100).toFixed(2) : null;
      map.set(code, {
        rocYear: parseInt(r['年度'] ?? '0', 10),
        season: parseInt(r['季別'] ?? '0', 10),
        code,
        industry: r['產業別'] ?? '',
        eps: toNum(r['基本每股盈餘(元)']),
        revenue,
        operatingIncome: opIncome,
        netIncome,
        netMargin,
        operatingMargin: opMargin,
      });
    }
    quarterlyCache = { data: map, expiresAt: Date.now() + TTL_QUARTERLY };
    return map;
  })();
  try { return await quarterlyInflight; }
  finally { quarterlyInflight = null; }
}

export async function getTwseQuarterly(code: string): Promise<TwseQuarterly | null> {
  try {
    const map = await fetchQuarterlyMap();
    return map.get(code) ?? null;
  } catch {
    quarterlyCache = { data: new Map(), expiresAt: Date.now() + TTL_FAILURE };
    return null;
  }
}

// ── Monthly (t187ap05_L) ────────────────────────────────────────────────────

interface MonthlyRow {
  '出表日期'?: string;
  '資料年月'?: string;
  '公司代號'?: string;
  '公司名稱'?: string;
  '產業別'?: string;
  '營業收入-當月營收'?: string;
  '營業收入-上月比較增減(%)'?: string;
  '營業收入-去年同月增減(%)'?: string;
  '累計營業收入-前期比較增減(%)'?: string;
}

async function fetchMonthlyMap(): Promise<Map<string, TwseMonthly>> {
  if (monthlyCache && Date.now() < monthlyCache.expiresAt) return monthlyCache.data;
  if (monthlyInflight) return monthlyInflight;

  monthlyInflight = (async () => {
    const res = await fetch(`${TWSE_BASE}/t187ap05_L`, {
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
      headers: { 'User-Agent': 'rockstock/1.0' },
    });
    if (!res.ok) throw new Error(`TWSE t187ap05_L HTTP ${res.status}`);
    const rows = await res.json() as MonthlyRow[];

    const map = new Map<string, TwseMonthly>();
    for (const r of rows) {
      const code = r['公司代號']?.trim();
      if (!code) continue;
      map.set(code, {
        yearMonth: r['資料年月'] ?? '',
        code,
        revenue: toNum(r['營業收入-當月營收']),
        revenueYoY: toNum(r['營業收入-去年同月增減(%)']),
        revenueMoM: toNum(r['營業收入-上月比較增減(%)']),
        cumRevenueYoY: toNum(r['累計營業收入-前期比較增減(%)']),
      });
    }
    monthlyCache = { data: map, expiresAt: Date.now() + TTL_MONTHLY };
    return map;
  })();
  try { return await monthlyInflight; }
  finally { monthlyInflight = null; }
}

export async function getTwseMonthly(code: string): Promise<TwseMonthly | null> {
  try {
    const map = await fetchMonthlyMap();
    return map.get(code) ?? null;
  } catch {
    monthlyCache = { data: new Map(), expiresAt: Date.now() + TTL_FAILURE };
    return null;
  }
}

// ── TPEx (上櫃) — 同 endpoint pattern，命名為 mopsfin_*_O ────────────────────

const tpexQuarterlyMap: { current: Map<string, TwseQuarterly> | null; expiresAt: number } = {
  current: null, expiresAt: 0,
};
const tpexMonthlyMap: { current: Map<string, TwseMonthly> | null; expiresAt: number } = {
  current: null, expiresAt: 0,
};
let tpexQuarterlyInflight: Promise<Map<string, TwseQuarterly>> | null = null;
let tpexMonthlyInflight: Promise<Map<string, TwseMonthly>> | null = null;

async function fetchTpexQuarterlyMap(): Promise<Map<string, TwseQuarterly>> {
  if (tpexQuarterlyMap.current && Date.now() < tpexQuarterlyMap.expiresAt) return tpexQuarterlyMap.current;
  if (tpexQuarterlyInflight) return tpexQuarterlyInflight;
  tpexQuarterlyInflight = (async () => {
    try {
      const res = await fetch(`${TPEX_BASE}/mopsfin_t187ap14_O`, {
        signal: AbortSignal.timeout(30_000),
        cache: 'no-store',
        headers: { 'User-Agent': 'rockstock/1.0' },
      });
      if (!res.ok) throw new Error(`TPEx mopsfin_t187ap14_O HTTP ${res.status}`);
      const rows = await res.json() as QuarterlyRow[];
      const map = new Map<string, TwseQuarterly>();
      for (const r of rows) {
        const code = r['公司代號']?.trim();
        if (!code) continue;
        const revenue = toNum(r['營業收入']);
        const opIncome = toNum(r['營業利益']);
        const netIncome = toNum(r['稅後淨利']);
        map.set(code, {
          rocYear: parseInt(r['年度'] ?? '0', 10),
          season: parseInt(r['季別'] ?? '0', 10),
          code,
          industry: r['產業別'] ?? '',
          eps: toNum(r['基本每股盈餘(元)']),
          revenue,
          operatingIncome: opIncome,
          netIncome,
          netMargin: revenue && netIncome != null ? +(netIncome / revenue * 100).toFixed(2) : null,
          operatingMargin: revenue && opIncome != null ? +(opIncome / revenue * 100).toFixed(2) : null,
        });
      }
      tpexQuarterlyMap.current = map;
      tpexQuarterlyMap.expiresAt = Date.now() + TTL_QUARTERLY;
      return map;
    } catch {
      const empty = new Map<string, TwseQuarterly>();
      tpexQuarterlyMap.current = empty;
      tpexQuarterlyMap.expiresAt = Date.now() + TTL_FAILURE;
      return empty;
    }
  })();
  try { return await tpexQuarterlyInflight; }
  finally { tpexQuarterlyInflight = null; }
}

async function fetchTpexMonthlyMap(): Promise<Map<string, TwseMonthly>> {
  if (tpexMonthlyMap.current && Date.now() < tpexMonthlyMap.expiresAt) return tpexMonthlyMap.current;
  if (tpexMonthlyInflight) return tpexMonthlyInflight;
  tpexMonthlyInflight = (async () => {
    try {
      const res = await fetch(`${TPEX_BASE}/mopsfin_t187ap05_O`, {
        signal: AbortSignal.timeout(30_000),
        cache: 'no-store',
        headers: { 'User-Agent': 'rockstock/1.0' },
      });
      if (!res.ok) throw new Error(`TPEx mopsfin_t187ap05_O HTTP ${res.status}`);
      const rows = await res.json() as MonthlyRow[];
      const map = new Map<string, TwseMonthly>();
      for (const r of rows) {
        const code = r['公司代號']?.trim();
        if (!code) continue;
        map.set(code, {
          yearMonth: r['資料年月'] ?? '',
          code,
          revenue: toNum(r['營業收入-當月營收']),
          revenueYoY: toNum(r['營業收入-去年同月增減(%)']),
          revenueMoM: toNum(r['營業收入-上月比較增減(%)']),
          cumRevenueYoY: toNum(r['累計營業收入-前期比較增減(%)']),
        });
      }
      tpexMonthlyMap.current = map;
      tpexMonthlyMap.expiresAt = Date.now() + TTL_MONTHLY;
      return map;
    } catch {
      const empty = new Map<string, TwseMonthly>();
      tpexMonthlyMap.current = empty;
      tpexMonthlyMap.expiresAt = Date.now() + TTL_FAILURE;
      return empty;
    }
  })();
  try { return await tpexMonthlyInflight; }
  finally { tpexMonthlyInflight = null; }
}

/**
 * 自動判斷上市/上櫃；先打 TWSE map，沒命中 fallback TPEx map。
 */
export async function getQuarterlyAny(code: string): Promise<TwseQuarterly | null> {
  const sii = await getTwseQuarterly(code);
  if (sii) return sii;
  const otc = await fetchTpexQuarterlyMap();
  return otc.get(code) ?? null;
}

export async function getMonthlyAny(code: string): Promise<TwseMonthly | null> {
  const sii = await getTwseMonthly(code);
  if (sii) return sii;
  const otc = await fetchTpexMonthlyMap();
  return otc.get(code) ?? null;
}

interface TwseCompanyRow {
  '公司代號'?: string;
  '公司名稱'?: string;
  '產業別'?: string;
  '已發行普通股數或TDR原股發行股數'?: string;
}

interface TpexCompanyRow {
  SecuritiesCompanyCode?: string;
  CompanyName?: string;
  SecuritiesIndustryCode?: string;
  IssueShares?: string;
}

/**
 * 上市／上櫃公司基本資料都是每日全市場 bulk；合併成單一 map，供 V 策略取得
 * 產業與已發行股數。整個 process 最多各打一個 endpoint，不做 per-stock request。
 */
async function fetchCompanyMap(): Promise<Map<string, TwCompanyProfile>> {
  if (companyCache && Date.now() < companyCache.expiresAt) return companyCache.data;
  if (companyInflight) return companyInflight;

  companyInflight = (async () => {
    const map = new Map<string, TwCompanyProfile>();
    const [twse, tpex] = await Promise.allSettled([
      fetch(`${TWSE_BASE}/t187ap03_L`, {
        signal: AbortSignal.timeout(30_000), cache: 'no-store', headers: { 'User-Agent': 'rockstock/1.0' },
      }).then(async (res) => {
        if (!res.ok) throw new Error(`TWSE t187ap03_L HTTP ${res.status}`);
        return res.json() as Promise<TwseCompanyRow[]>;
      }),
      fetch(`${TPEX_BASE}/mopsfin_t187ap03_O`, {
        signal: AbortSignal.timeout(30_000), cache: 'no-store', headers: { 'User-Agent': 'rockstock/1.0' },
      }).then(async (res) => {
        if (!res.ok) throw new Error(`TPEx mopsfin_t187ap03_O HTTP ${res.status}`);
        return res.json() as Promise<TpexCompanyRow[]>;
      }),
    ]);

    if (twse.status === 'fulfilled') {
      for (const row of twse.value) {
        const code = row['公司代號']?.trim();
        if (!code) continue;
        map.set(code, {
          code,
          name: row['公司名稱']?.trim() ?? '',
          industry: row['產業別']?.trim() ?? '',
          issuedShares: toNum(row['已發行普通股數或TDR原股發行股數']),
          marketType: 'twse',
        });
      }
    }
    if (tpex.status === 'fulfilled') {
      for (const row of tpex.value) {
        const code = row.SecuritiesCompanyCode?.trim();
        if (!code) continue;
        map.set(code, {
          code,
          name: row.CompanyName?.trim() ?? '',
          industry: row.SecuritiesIndustryCode?.trim() ?? '',
          issuedShares: toNum(row.IssueShares),
          marketType: 'tpex',
        });
      }
    }

    companyCache = {
      data: map,
      expiresAt: Date.now() + (map.size > 0 ? TTL_QUARTERLY : TTL_FAILURE),
    };
    return map;
  })();
  try { return await companyInflight; }
  finally { companyInflight = null; }
}

export async function getCompanyAny(code: string): Promise<TwCompanyProfile | null> {
  try {
    return (await fetchCompanyMap()).get(code) ?? null;
  } catch {
    return null;
  }
}
