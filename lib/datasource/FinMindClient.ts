/**
 * FinMind API Client
 * Free tier: 300 requests/hour, no API key required for basic datasets
 * Paid tier: higher rate limits with API token
 *
 * Docs: https://finmindtrade.com/analysis/#/data/api
 */

const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4/data';
const FINMIND_TOKEN = process.env.FINMIND_API_TOKEN ?? '';  // optional paid token

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

async function finmindFetch<T>(dataset: string, params: Record<string, string>): Promise<T[]> {
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
      signal: AbortSignal.timeout(15000),
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

export interface InstitutionalRow {
  date: string;
  stock_id: string;
  Foreign_Investor_buy: number;
  Foreign_Investor_sell: number;
  Foreign_Investor_buy_sell: number;  // net
  Investment_Trust_buy: number;
  Investment_Trust_sell: number;
  Investment_Trust_buy_sell: number;  // net
  Dealer_self_buy: number;
  Dealer_self_sell: number;
  Dealer_self_buy_sell: number;  // net
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
  date: string;           // YYYY-MM
  stock_id: string;
  revenue: number;
  revenue_month: number;
  revenue_year: number;
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
  epsYoY: number | null;   // EPS YoY growth %
  grossMargin: number | null;
  netMargin: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  revenueLatest: number | null;
  revenueMoM: number | null;  // month-over-month %
  revenueYoY: number | null;  // year-over-year %
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

    const rows = await finmindFetch<InstitutionalRow>('TaiwanStockInstitutionalInvestors', {
      data_id: stockId,
      start_date: start,
    });

    // Sort descending by date
    rows.sort((a, b) => b.date.localeCompare(a.date));
    const recent = rows.slice(0, days);

    // Calculate consecutive foreign buy days
    let consecutiveForeignBuy = 0;
    for (const r of recent) {
      if (r.Foreign_Investor_buy_sell > 0) consecutiveForeignBuy++;
      else break;
    }

    const result: InstitutionalData[] = recent.map(r => ({
      date: r.date,
      foreignNet: r.Foreign_Investor_buy_sell,
      trustNet: r.Investment_Trust_buy_sell,
      dealerNet: r.Dealer_self_buy_sell,
      totalNet: r.Foreign_Investor_buy_sell + r.Investment_Trust_buy_sell + r.Dealer_self_buy_sell,
      consecutiveForeignBuy,
    }));

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

    rows.sort((a, b) => b.date.localeCompare(a.date));
    const recent = rows.slice(0, months);
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
  };

  cacheSet(cacheKey, result, TTL.FUNDAMENTALS);
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
