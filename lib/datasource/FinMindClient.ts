/**
 * FinMind API Client
 * Free tier: 300 requests/hour, no API key required for basic datasets
 * Paid tier: higher rate limits with API token
 *
 * Docs: https://finmindtrade.com/analysis/#/data/api
 */

import { getFinMindToken } from '@/lib/env';

const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4/data';
const FINMIND_TOKEN = getFinMindToken() ?? '';  // optional paid token

const TTL = {
  INSTITUTIONAL:  24 * 60 * 60 * 1000,  // 24h
  FUNDAMENTALS:   24 * 60 * 60 * 1000,  // 24h
  MARGIN:         24 * 60 * 60 * 1000,  // 24h
  STOCK_INFO:     7 * 24 * 60 * 60 * 1000,   // 7d — industry rarely changes
  GOVERNANCE:     7 * 24 * 60 * 60 * 1000,   // 7d — board / insider data updates weekly
} as const;

// ── In-memory cache ────────────────────────────────────────────────────────────

const cache = new Map<string, { data: unknown; expiresAt: number }>();

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function cacheSet<T>(key: string, data: T, ttl: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

// ── FinMind API fetch ──────────────────────────────────────────────────────────

/**
 * 標記：偵測到 token 無效後，整個 process 切回免費層（不再帶 token）
 * 避免每次 request 都先失敗再 retry，浪費一個 round trip。
 */
let tokenDisabled = false;

export async function finmindFetch<T>(dataset: string, params: Record<string, string>): Promise<T[]> {
  const useToken: boolean = Boolean(FINMIND_TOKEN) && !tokenDisabled;

  const buildUrl = (withToken: boolean): URL => {
    const u = new URL(FINMIND_BASE);
    u.searchParams.set('dataset', dataset);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (withToken) u.searchParams.set('token', FINMIND_TOKEN);
    return u;
  };

  const doFetch = async (withToken: boolean): Promise<Response> => {
    return fetch(buildUrl(withToken).toString(), {
      signal: AbortSignal.timeout(6000),
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });
  };

  let res = await doFetch(useToken);

  // 偵測 token 過期/無效 → 永久 disable token，retry 一次（FinMind 免費層仍 work）
  if (!res.ok && useToken && (res.status === 400 || res.status === 401 || res.status === 403)) {
    const body = await res.text().catch(() => '');
    if (/token/i.test(body)) {
      console.warn(`[FinMind] token rejected (${res.status}), falling back to free tier for the rest of this process`);
      tokenDisabled = true;
      res = await doFetch(false);
    } else {
      throw new Error(`FinMind ${res.status} ${res.statusText} body=${body.slice(0, 200)}`);
    }
  }

  // 額度用罄（402 "Requests reach the upper limit" / 429）：付費 token 的 hourly 配額打爆，
  // 但免費層是 per-IP 另計配額、常常還有額度 → 退免費層 retry 一次（本次請求限定，不永久 disable，
  // 因為限流是暫時的、下個小時就回復，token 在未撞限時段仍有更高配額）。
  // 不修這條時：402 會一路 throw 進 getQuarterlyHistory 等 catch 被靜默吞成空陣列 →
  // ttmEps=null → 估值面板誤報「FinMind 尚未開放或代號錯誤」（實際只是限流）。
  if (!res.ok && useToken && (res.status === 402 || res.status === 429)) {
    console.warn(`[FinMind] token rate-limited (${res.status}) on ${dataset}, retrying on free tier`);
    res = await doFetch(false);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`FinMind ${res.status} ${res.statusText} body=${body.slice(0, 200)}`);
  }

  const json = await res.json() as { status: number; data: T[] };

  if (json.status !== 200) {
    throw new Error(`FinMind API status: ${json.status}`);
  }

  return json.data ?? [];
}

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * dataset=TaiwanStockInstitutionalInvestorsBuySellWide 的一列。
 * 2026-07-23：FinMind 把舊的 `TaiwanStockInstitutionalInvestors` 下架（打過去只回 enum
 * validation error，不是 4xx），舊呼叫被 catch 吞成空陣列 → /api/institutional 一路回 null，
 * chipAgent 的「法人連續買賣超天數」整個失效。Wide 變體欄位對得上，但**只給 buy / sell
 * 不給 net**，淨額要自己相減。
 */
export interface InstitutionalRow {
  date: string;
  stock_id: string;
  Foreign_Investor_buy: number;
  Foreign_Investor_sell: number;
  Investment_Trust_buy: number;
  Investment_Trust_sell: number;
  Dealer_self_buy: number;
  Dealer_self_sell: number;
}

export interface MarginRow {
  date: string;
  stock_id: string;
  MarginPurchaseBuy: number;
  MarginPurchaseSell: number;
  MarginPurchaseCashRepayment: number;
  MarginPurchaseToday: number;
  ShortSaleBuy: number;
  ShortSaleSell: number;
  ShortSaleToday: number;
}

export interface RevenueRow {
  /** 正規化後的實際營收月份 YYYY-MM-01；FinMind 原始 date 是次月公告資料列日期。 */
  date: string;
  stock_id: string;
  revenue: number;
  revenue_month: number;
  revenue_year: number;
}

/**
 * FinMind TaiwanStockMonthRevenue 的 date 是次月 1 日，真正月份在 revenue_year/month。
 * 例如 date=2026-07-01, revenue_month=6 代表 2026 年 6 月營收。
 */
export function normalizeRevenuePeriod(row: RevenueRow): RevenueRow {
  const year = Number(row.revenue_year);
  const month = Number(row.revenue_month);
  if (!Number.isInteger(year) || year < 1900 || year > 2200 || !Number.isInteger(month) || month < 1 || month > 12) {
    return row;
  }
  return { ...row, date: `${year}-${String(month).padStart(2, '0')}-01` };
}

/**
 * FinMind TaiwanStockFinancialStatements 實際回傳格式（2026-05-22 修）
 *
 * 不是「一筆 row 一個季度 + 多個 metric 欄位」，
 * 而是「一筆 row 一個 metric value」 — type 是 metric 名（EPS/GrossProfit/Revenue 等），
 * value 是該 metric 該季的金額/比率。
 *
 * 範例：{ date: '2026-03-31', stock_id: '2330', type: 'EPS', value: 22.08, origin_name: '基本每股盈餘' }
 */
export interface FinancialRow {
  date: string;
  stock_id: string;
  type: string;          // 'EPS' / 'GrossProfit' / 'Revenue' / 'IncomeAfterTaxes' 等
  value: number;
  origin_name?: string;
}

export interface PERatioRow {
  date: string;
  stock_id: string;
  PER: number | null;
  PBR: number | null;
  dividend_yield: number | null;
}

// ── Normalized output types ────────────────────────────────────────────────────

export interface InstitutionalData {
  date: string;
  foreignNet: number;      // 外資買賣超（張）
  trustNet: number;        // 投信買賣超（張）
  dealerNet: number;       // 自營商買賣超（張）
  totalNet: number;        // 三大法人合計
  consecutiveForeignBuy: number;  // 外資連買天數
}

export interface MarginData {
  date: string;
  marginBalance: number;   // 融資餘額（張）
  shortBalance: number;    // 融券餘額（張）
  marginRatio: number;     // 融資/成交量比例
}

export interface FundamentalsData {
  eps: number | null;
  /** 交易所最新財報的本年度累計基本 EPS（與 eps 單季口徑分開）。 */
  epsYtd?: number | null;
  epsYoY: number | null;   // EPS YoY growth %
  grossMargin: number | null;
  netMargin: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  revenueLatest: number | null;
  revenueMoM: number | null;  // month-over-month %
  revenueYoY: number | null;  // year-over-year %
  /** 期別 metadata（optional，給 UI 顯示「26Q1」「2026 年 4 月」）*/
  periods?: {
    /** 財報期 YYYY-MM-DD（e.g. 2026-03-31 = 26Q1）*/
    financialReportDate?: string | null;
    /** 實際月營收月份 YYYY-MM-DD（不是 FinMind 次月公告資料列日期）。 */
    revenueMonth?: string | null;
    /** PER/PBR/殖利率的交易日 YYYY-MM-DD（即時市價，每日更新）*/
    valuationDate?: string | null;
  };
}

// ── Public API functions ───────────────────────────────────────────────────────

/**
 * 取得三大法人買賣超 — 最近 N 天
 */
export async function getInstitutional(
  stockId: string,
  days = 20,
): Promise<InstitutionalData[]> {
  const cacheKey = `institutional:${stockId}:${days}`;
  const cached = cacheGet<InstitutionalData[]>(cacheKey);
  if (cached) return cached;

  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days * 2);  // extra buffer for weekends
    const start = startDate.toISOString().split('T')[0];

    const rows = await finmindFetch<InstitutionalRow>('TaiwanStockInstitutionalInvestorsBuySellWide', {
      data_id: stockId,
      start_date: start,
    });

    // Sort descending by date
    rows.sort((a, b) => b.date.localeCompare(a.date));
    const recent = rows.slice(0, days);

    // Wide dataset 只給 buy / sell，淨額自己算（單位＝股，與舊 dataset 一致）
    const net = (r: InstitutionalRow) => ({
      foreign: (r.Foreign_Investor_buy ?? 0) - (r.Foreign_Investor_sell ?? 0),
      trust:   (r.Investment_Trust_buy ?? 0) - (r.Investment_Trust_sell ?? 0),
      dealer:  (r.Dealer_self_buy ?? 0) - (r.Dealer_self_sell ?? 0),
    });

    // Calculate consecutive foreign buy days
    let consecutiveForeignBuy = 0;
    for (const r of recent) {
      if (net(r).foreign > 0) consecutiveForeignBuy++;
      else break;
    }

    const result: InstitutionalData[] = recent.map(r => {
      const n = net(r);
      return {
        date: r.date,
        foreignNet: n.foreign,
        trustNet: n.trust,
        dealerNet: n.dealer,
        totalNet: n.foreign + n.trust + n.dealer,
        consecutiveForeignBuy,
      };
    });

    cacheSet(cacheKey, result, TTL.INSTITUTIONAL);
    return result;
  } catch {
    return [];
  }
}

/**
 * 取得融資融券餘額 — 最近 N 天
 */
export async function getMarginBalance(
  stockId: string,
  days = 10,
): Promise<MarginData[]> {
  const cacheKey = `margin:${stockId}:${days}`;
  const cached = cacheGet<MarginData[]>(cacheKey);
  if (cached) return cached;

  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days * 2);
    const start = startDate.toISOString().split('T')[0];

    const rows = await finmindFetch<MarginRow>('TaiwanStockMarginPurchaseShortSale', {
      data_id: stockId,
      start_date: start,
    });

    rows.sort((a, b) => b.date.localeCompare(a.date));
    const recent = rows.slice(0, days);

    const result: MarginData[] = recent.map(r => ({
      date: r.date,
      marginBalance: r.MarginPurchaseToday,
      shortBalance: r.ShortSaleToday,
      marginRatio: 0,  // requires volume data to compute
    }));

    cacheSet(cacheKey, result, TTL.MARGIN);
    return result;
  } catch {
    return [];
  }
}

/**
 * 取得月營收 — 最近 N 個月
 */
export async function getMonthlyRevenue(
  stockId: string,
  months = 12,
): Promise<RevenueRow[]> {
  const cacheKey = `revenue:${stockId}:${months}`;
  const cached = cacheGet<RevenueRow[]>(cacheKey);
  if (cached) return cached;

  try {
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months - 1);
    const start = startDate.toISOString().split('T')[0];

    const rows = await finmindFetch<RevenueRow>('TaiwanStockMonthRevenue', {
      data_id: stockId,
      start_date: start,
    });

    const normalized = rows.map(normalizeRevenuePeriod);
    normalized.sort((a, b) => b.date.localeCompare(a.date));
    const recent = normalized.slice(0, months);
    cacheSet(cacheKey, recent, TTL.FUNDAMENTALS);
    return recent;
  } catch {
    return [];
  }
}

/**
 * 取得財務指標（EPS、毛利率、淨利率）+ P/E、P/B — 合併成 FundamentalsData
 */
export async function getFundamentals(stockId: string): Promise<FundamentalsData> {
  const cacheKey = `fundamentals:${stockId}`;
  const cached = cacheGet<FundamentalsData>(cacheKey);
  if (cached) return cached;

  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 2);
  const start = startDate.toISOString().split('T')[0];

  const [financials, peRows, revenues] = await Promise.allSettled([
    finmindFetch<FinancialRow>('TaiwanStockFinancialStatements', { data_id: stockId, start_date: start }),
    finmindFetch<PERatioRow>('TaiwanStockPER', { data_id: stockId, start_date: start }),
    getMonthlyRevenue(stockId, 13),
  ]);

  const finData = financials.status === 'fulfilled' ? financials.value : [];
  const peData  = peRows.status === 'fulfilled' ? peRows.value : [];
  const revData = revenues.status === 'fulfilled' ? revenues.value : [];

  // 2026-05-22 修：FinMind 實際回的是 key-value rows（type/value），
  // 不是「一筆 row 多欄位」。要先 group by date，再從中找 type='EPS'/'GrossProfit'/'IncomeAfterTaxes' 等。
  const finByDate = new Map<string, Map<string, number>>();
  for (const r of finData) {
    if (!r.date || !r.type || typeof r.value !== 'number') continue;
    if (!finByDate.has(r.date)) finByDate.set(r.date, new Map());
    finByDate.get(r.date)!.set(r.type, r.value);
  }
  const finDates = [...finByDate.keys()].sort((a, b) => b.localeCompare(a));
  const latestDate = finDates[0];
  const prevDate   = finDates[1];

  // 提取 metric helper
  const getMetric = (date: string | undefined, key: string): number | null => {
    if (!date) return null;
    const v = finByDate.get(date)?.get(key);
    return typeof v === 'number' ? v : null;
  };

  const latestEPS         = getMetric(latestDate, 'EPS');
  const prevEPS           = getMetric(prevDate, 'EPS');
  const latestRevenue     = getMetric(latestDate, 'Revenue');
  const latestGrossProfit = getMetric(latestDate, 'GrossProfit');
  const latestNetIncome   = getMetric(latestDate, 'IncomeAfterTaxes');

  // 毛利率 = GrossProfit / Revenue × 100
  const grossMargin = latestRevenue && latestGrossProfit
    ? (latestGrossProfit / latestRevenue) * 100
    : null;
  // 淨利率 = IncomeAfterTaxes / Revenue × 100
  const netMargin = latestRevenue && latestNetIncome
    ? (latestNetIncome / latestRevenue) * 100
    : null;

  // Latest P/E
  peData.sort((a, b) => b.date.localeCompare(a.date));
  const latestPE = peData[0];

  // Revenue MoM / YoY
  let revenueMoM: number | null = null;
  let revenueYoY: number | null = null;
  let revenueLatest: number | null = null;
  if (revData.length >= 1) {
    revenueLatest = revData[0].revenue;
    if (revData.length >= 2 && revData[1].revenue > 0) {
      revenueMoM = ((revData[0].revenue - revData[1].revenue) / revData[1].revenue) * 100;
    }
    if (revData.length >= 13 && revData[12].revenue > 0) {
      revenueYoY = ((revData[0].revenue - revData[12].revenue) / revData[12].revenue) * 100;
    }
  }

  // EPS YoY（用最新季 vs 上一季 — FinMind 提供季資料，不是年資料）
  let epsYoY: number | null = null;
  if (latestEPS != null && prevEPS != null && prevEPS !== 0) {
    epsYoY = ((latestEPS - prevEPS) / Math.abs(prevEPS)) * 100;
  }

  const result: FundamentalsData = {
    eps: latestEPS,
    epsYoY,
    grossMargin,
    netMargin,
    per: latestPE?.PER ?? null,
    pbr: latestPE?.PBR ?? null,
    dividendYield: latestPE?.dividend_yield ?? null,
    revenueLatest,
    revenueMoM,
    revenueYoY,
    periods: {
      financialReportDate: latestDate ?? null,
      revenueMonth: revData[0]?.date ?? null,
      valuationDate: latestPE?.date ?? null,
    },
  };

  // 只在拿到任一可用欄位時才 cache — 避免 FinMind 限流/未授權時 cache 卡 stale 空白
  const hasUseful =
    result.eps != null ||
    result.per != null ||
    result.pbr != null ||
    result.revenueLatest != null;
  if (hasUseful) {
    cacheSet(cacheKey, result, TTL.FUNDAMENTALS);
  }
  return result;
}

// ── Stock info (industry) ─────────────────────────────────────────────────────

export interface StockInfoRow {
  industry_category: string;
  stock_id: string;
  stock_name: string;
  type: string;  // twse / tpex
  date: string;
}

export interface StockInfoData {
  stock_id: string;
  stock_name: string;
  industry_category: string;
  market_type: string;
}

export async function getStockInfo(stockId: string): Promise<StockInfoData | null> {
  const cacheKey = `stockinfo:${stockId}`;
  const cached = cacheGet<StockInfoData>(cacheKey);
  if (cached) return cached;

  try {
    const rows = await finmindFetch<StockInfoRow>('TaiwanStockInfo', {
      data_id: stockId,
    });
    if (rows.length === 0) return null;
    const r = rows[0];
    const result: StockInfoData = {
      stock_id: r.stock_id,
      stock_name: r.stock_name,
      industry_category: r.industry_category,
      market_type: r.type,
    };
    cacheSet(cacheKey, result, TTL.STOCK_INFO);
    return result;
  } catch {
    return null;
  }
}

// ── Governance（外資持股比率 — 公開可得） ─────────────────────────────────────
//
// FinMind 免費層級無「大戶持股分級」與「內部人交易」。
// 替代品：TaiwanStockShareholding 提供「外資持股比率」每日更新，
// 看 4 週變化即可作為長期資金面信號。

export interface ShareholdingRow {
  date: string;
  stock_id: string;
  stock_name: string;
  ForeignInvestmentRemainingShares: number;
  ForeignInvestmentShares: number;
  ForeignInvestmentRemainRatio: number;       // 外資餘額比率（可投資餘額 / 總股本）
  ForeignInvestmentSharesRatio: number;       // 外資持股比率（外資已持有 / 總股本）
  ForeignInvestmentUpperLimitRatio: number;
  ChineseInvestmentUpperLimitRatio: number;
  NumberOfSharesIssued: number;
  RecentlyDeclareDate: string;
  note: string;
}

export interface GovernanceData {
  /** 外資持股比率（%） */
  foreign_ownership_pct: number | null;
  /** 外資持股 4 週前比率（%） */
  foreign_ownership_pct_4w_ago: number | null;
  /** 外資持股 4 週變化（pp）— 正=外資加碼長期 */
  foreign_ownership_delta_4w: number | null;
  /** 外資餘額比率（可投資餘額 / 總股本）（%） */
  foreign_remaining_ratio: number | null;
  /** 資料截止日 */
  data_date: string | null;
}

export async function getGovernance(stockId: string): Promise<GovernanceData | null> {
  const cacheKey = `governance:${stockId}`;
  const cached = cacheGet<GovernanceData>(cacheKey);
  if (cached) return cached;

  try {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 40);   // ~ 5 週往前

    const rows = await finmindFetch<ShareholdingRow>('TaiwanStockShareholding', {
      data_id: stockId,
      start_date: start.toISOString().split('T')[0],
    });
    if (rows.length === 0) return null;

    rows.sort((a, b) => a.date.localeCompare(b.date));
    const latest = rows[rows.length - 1];
    // 找距離 latest 4 週前最接近的那一筆
    const latestMs = new Date(latest.date).getTime();
    const target = latestMs - 28 * 86400_000;
    let baseline = rows[0];
    let bestGap = Math.abs(new Date(rows[0].date).getTime() - target);
    for (const r of rows) {
      const gap = Math.abs(new Date(r.date).getTime() - target);
      if (gap < bestGap) { bestGap = gap; baseline = r; }
    }

    const delta =
      latest.ForeignInvestmentSharesRatio != null && baseline.ForeignInvestmentSharesRatio != null
        ? Number((latest.ForeignInvestmentSharesRatio - baseline.ForeignInvestmentSharesRatio).toFixed(2))
        : null;

    const result: GovernanceData = {
      foreign_ownership_pct: latest.ForeignInvestmentSharesRatio ?? null,
      foreign_ownership_pct_4w_ago: baseline?.ForeignInvestmentSharesRatio ?? null,
      foreign_ownership_delta_4w: delta,
      foreign_remaining_ratio: latest.ForeignInvestmentRemainRatio ?? null,
      data_date: latest.date,
    };
    cacheSet(cacheKey, result, TTL.GOVERNANCE);
    return result;
  } catch {
    return null;
  }
}

/**
 * 取得個股最新「已發行股數」（NumberOfSharesIssued）— 用於把投信淨買張數換算成持股 %。
 *
 * 資料源：TaiwanStockShareholding 每日揭露，rockstock 既有用其外資持股比率欄位；
 * 此 helper 改抽 NumberOfSharesIssued 欄位（股數，不是張數）。
 * 股本變動低頻 — cache TTL 用 fundamentals 等級（24h）。
 */
export async function getSharesIssued(stockId: string): Promise<number | null> {
  const cacheKey = `sharesIssued:${stockId}`;
  const cached = cacheGet<number>(cacheKey);
  if (cached !== null && cached !== undefined) return cached;

  try {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 14);

    const rows = await finmindFetch<ShareholdingRow>('TaiwanStockShareholding', {
      data_id: stockId,
      start_date: start.toISOString().split('T')[0],
    });
    if (rows.length === 0) return null;

    rows.sort((a, b) => a.date.localeCompare(b.date));
    const latest = rows[rows.length - 1];
    const shares = latest.NumberOfSharesIssued;
    if (!shares || shares <= 0) return null;

    cacheSet(cacheKey, shares, TTL.FUNDAMENTALS);
    return shares;
  } catch {
    return null;
  }
}

// ── Quarterly history（近 N 季逐季 EPS / 營收 / 淨利率） ────────────────────────

export interface QuarterlyHistoryRow {
  quarter: string;          // YYYY-MM-DD（季底）
  revenue: number | null;
  grossProfit: number | null;
  netIncome: number | null;
  eps: number | null;
  netMargin: number | null;
  grossMargin: number | null;
}

/**
 * 取得近 N 季逐季財報（for TTM PE 計算 + 三情境推估）。
 * 由近到遠排序（quarters[0] 是最新一季）。
 */
export async function getQuarterlyHistory(
  stockId: string,
  quarters = 8,
): Promise<QuarterlyHistoryRow[]> {
  const cacheKey = `quarterlyHistory:${stockId}:${quarters}`;
  const cached = cacheGet<QuarterlyHistoryRow[]>(cacheKey);
  if (cached) return cached;

  try {
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 3);
    const start = startDate.toISOString().split('T')[0];

    const rows = await finmindFetch<FinancialRow>('TaiwanStockFinancialStatements', {
      data_id: stockId,
      start_date: start,
    });

    const byDate = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!r.date || !r.type || typeof r.value !== 'number') continue;
      if (!byDate.has(r.date)) byDate.set(r.date, new Map());
      byDate.get(r.date)!.set(r.type, r.value);
    }

    const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a)).slice(0, quarters);

    const result: QuarterlyHistoryRow[] = dates.map((date) => {
      const m = byDate.get(date)!;
      const revenue = m.get('Revenue') ?? null;
      const grossProfit = m.get('GrossProfit') ?? null;
      const netIncome = m.get('IncomeAfterTaxes') ?? null;
      const eps = m.get('EPS') ?? null;
      const netMargin = revenue && netIncome ? netIncome / revenue : null;
      const grossMargin = revenue && grossProfit ? grossProfit / revenue : null;
      return { quarter: date, revenue, grossProfit, netIncome, eps, netMargin, grossMargin };
    });

    if (result.length > 0) cacheSet(cacheKey, result, TTL.FUNDAMENTALS);
    return result;
  } catch (e) {
    // 不靜默吞：限流(402)/逾時等失敗會讓 computeTTM 回 null → 估值誤報「代號錯誤」，難診斷。
    console.warn(`[FinMind] getQuarterlyHistory(${stockId}) failed: ${(e as Error).message}`);
    return [];
  }
}

// ── Balance sheet（股東權益、每股淨值） ─────────────────────────────────────────

export interface BalanceSheetData {
  date: string;
  equity: number | null;             // 股東權益總計
  bookValuePerShare: number | null;  // 每股淨值
}

/**
 * 取得最新一季資產負債表精要（for PB 計算與景氣循環股估值）。
 * FinMind TaiwanStockBalanceSheet 也是 type/value 結構。
 */
export async function getBalanceSheet(stockId: string): Promise<BalanceSheetData | null> {
  const cacheKey = `balanceSheet:${stockId}`;
  const cached = cacheGet<BalanceSheetData>(cacheKey);
  if (cached) return cached;

  try {
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 1);
    const start = startDate.toISOString().split('T')[0];

    const rows = await finmindFetch<FinancialRow>('TaiwanStockBalanceSheet', {
      data_id: stockId,
      start_date: start,
    });

    const byDate = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!r.date || !r.type || typeof r.value !== 'number') continue;
      if (!byDate.has(r.date)) byDate.set(r.date, new Map());
      byDate.get(r.date)!.set(r.type, r.value);
    }

    const latestDate = [...byDate.keys()].sort((a, b) => b.localeCompare(a))[0];
    if (!latestDate) return null;

    const m = byDate.get(latestDate)!;
    const equity = m.get('Equity') ?? m.get('TotalEquity') ?? null;
    const shares = await getSharesIssued(stockId);
    // equity 與 shares 都以「元 / 股」為原始單位（FinMind 仟元注釋的欄位另有 ThousandUnit；
    // TaiwanStockBalanceSheet 對 type='Equity' 的 value 已是元，shares 是股數，直接除即為元/股）
    const bookValuePerShare = equity && shares && shares > 0 ? equity / shares : null;

    const result: BalanceSheetData = { date: latestDate, equity, bookValuePerShare };
    cacheSet(cacheKey, result, TTL.FUNDAMENTALS);
    return result;
  } catch {
    return null;
  }
}

/**
 * 取得最近 N 天的三大法人合計摘要（for scan results table）
 */
export async function getInstitutionalSummary(stockId: string, days = 5): Promise<{
  foreignNet5d: number;
  trustNet5d: number;
  totalNet5d: number;
  consecutiveForeignBuy: number;
} | null> {
  try {
    const data = await getInstitutional(stockId, days);
    if (data.length === 0) return null;
    return {
      foreignNet5d: data.reduce((s, r) => s + r.foreignNet, 0),
      trustNet5d:   data.reduce((s, r) => s + r.trustNet, 0),
      totalNet5d:   data.reduce((s, r) => s + r.totalNet, 0),
      consecutiveForeignBuy: data[0].consecutiveForeignBuy,
    };
  } catch {
    return null;
  }
}
