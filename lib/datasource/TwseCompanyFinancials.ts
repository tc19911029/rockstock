/**
 * TWSE 投資資訊中心 — 上市公司歷季 EPS / 利潤率 / 月營收。
 *
 * 官方個股財務頁使用的 JSON：
 *   https://www.twse.com.tw/rwd/zh/IIH/company/financial?code=3443
 *
 * 這個來源一次回傳 13 季單季 EPS、單季毛利率／稅後純益率，以及 13 個月
 * 月營收。它不是 OpenAPI Swagger 的正式端點，因此保留短失敗快取並讓呼叫端
 * 在資料結構改變時回退 FinMind；成功資料則快取 24 小時，避免重複打官方站。
 */

const TWSE_FINANCIAL_URL = 'https://www.twse.com.tw/rwd/zh/IIH/company/financial';
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;

export interface TwseCompanyQuarter {
  quarter: string;
  revenue: number | null;
  grossProfit: number | null;
  netIncome: number | null;
  eps: number | null;
  netMargin: number | null;
  grossMargin: number | null;
}

export interface TwseCompanyMonthlyRevenue {
  month: string;
  revenue: number;
}

export interface TwseCompanyFinancialHistory {
  quarterly: TwseCompanyQuarter[];
  monthlyRevenue: TwseCompanyMonthlyRevenue[];
  sourceUrl: string;
}

interface ChartSeries {
  name?: unknown;
  data?: unknown;
}

interface ChartBlock {
  categories?: unknown;
  series?: unknown;
}

interface TwseCompanyFinancialResponse {
  info?: {
    status?: unknown;
  };
  chart?: {
    eps?: ChartBlock;
    profit?: ChartBlock;
    revenue?: ChartBlock;
  };
}

interface CacheEntry {
  value: TwseCompanyFinancialHistory | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<TwseCompanyFinancialHistory | null>>();

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : [];
}

function chartSeries(block: ChartBlock | undefined): ChartSeries[] {
  return Array.isArray(block?.series) ? block.series as ChartSeries[] : [];
}

function seriesData(series: ChartSeries | undefined): unknown[] {
  return Array.isArray(series?.data) ? series.data : [];
}

function findSeries(block: ChartBlock | undefined, name: RegExp, fallbackIndex: number): unknown[] {
  const series = chartSeries(block);
  const matched = series.find(item => typeof item.name === 'string' && name.test(item.name));
  return seriesData(matched ?? series[fallbackIndex]);
}

function quarterEnd(label: string): string | null {
  const match = label.match(/^(\d{4})Q([1-4])$/);
  if (!match) return null;
  const monthDay = ['03-31', '06-30', '09-30', '12-31'][Number(match[2]) - 1];
  return `${match[1]}-${monthDay}`;
}

function monthLabel(value: string): string | null {
  const match = value.match(/^(\d{4})(\d{2})$/);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${match[2]}-01`;
}

function quarterLabelFromMonth(value: string): string | null {
  const match = value.match(/^(\d{4})(\d{2})$/);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}Q${Math.ceil(month / 3)}`;
}

/** Pure parser exported for contract tests and source-shape monitoring. */
export function parseTwseCompanyFinancials(
  payload: unknown,
  sourceUrl = TWSE_FINANCIAL_URL,
): TwseCompanyFinancialHistory | null {
  if (!payload || typeof payload !== 'object') return null;
  const response = payload as TwseCompanyFinancialResponse;
  if (response.info?.status !== 'success') return null;

  const epsCategories = stringArray(response.chart?.eps?.categories);
  const epsData = seriesData(chartSeries(response.chart?.eps)[0]);
  if (epsCategories.length < 4 || epsData.length !== epsCategories.length) return null;

  const profitCategories = stringArray(response.chart?.profit?.categories);
  const grossMarginData = findSeries(response.chart?.profit, /毛利率|gross margin/i, 0);
  const netMarginData = findSeries(response.chart?.profit, /稅後純益率|profit margin after tax/i, 1);
  const grossMarginByQuarter = new Map<string, number>();
  const netMarginByQuarter = new Map<string, number>();
  for (let index = 0; index < profitCategories.length; index += 1) {
    const grossMargin = finiteNumber(grossMarginData[index]);
    const netMargin = finiteNumber(netMarginData[index]);
    if (grossMargin != null) grossMarginByQuarter.set(profitCategories[index], grossMargin / 100);
    if (netMargin != null) netMarginByQuarter.set(profitCategories[index], netMargin / 100);
  }

  const revenueCategories = stringArray(response.chart?.revenue?.categories);
  const revenueData = seriesData(chartSeries(response.chart?.revenue)[0]);
  const monthlyRevenue: TwseCompanyMonthlyRevenue[] = [];
  const revenueByQuarter = new Map<string, number[]>();
  for (let index = 0; index < revenueCategories.length; index += 1) {
    const month = monthLabel(revenueCategories[index]);
    const quarter = quarterLabelFromMonth(revenueCategories[index]);
    const revenue = finiteNumber(revenueData[index]);
    if (!month || !quarter || revenue == null) continue;
    monthlyRevenue.push({ month, revenue });
    if (!revenueByQuarter.has(quarter)) revenueByQuarter.set(quarter, []);
    revenueByQuarter.get(quarter)!.push(revenue);
  }
  monthlyRevenue.sort((a, b) => b.month.localeCompare(a.month));

  const quarterly = epsCategories.flatMap((label, index): TwseCompanyQuarter[] => {
    const quarter = quarterEnd(label);
    const eps = finiteNumber(epsData[index]);
    if (!quarter || eps == null) return [];

    const monthlyValues = revenueByQuarter.get(label) ?? [];
    const revenue = monthlyValues.length === 3
      ? monthlyValues.reduce((sum, value) => sum + value, 0)
      : null;
    const grossMargin = grossMarginByQuarter.get(label) ?? null;
    const netMargin = netMarginByQuarter.get(label) ?? null;

    return [{
      quarter,
      revenue,
      grossProfit: revenue != null && grossMargin != null ? revenue * grossMargin : null,
      netIncome: revenue != null && netMargin != null ? revenue * netMargin : null,
      eps,
      netMargin,
      grossMargin,
    }];
  }).sort((a, b) => b.quarter.localeCompare(a.quarter));

  if (quarterly.length < 4) return null;
  return { quarterly, monthlyRevenue, sourceUrl };
}

export function twseCompanyFinancialUrl(code: string): string {
  const url = new URL(TWSE_FINANCIAL_URL);
  url.searchParams.set('code', code);
  return url.toString();
}

export async function getTwseCompanyFinancials(
  code: string,
): Promise<TwseCompanyFinancialHistory | null> {
  const cached = cache.get(code);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const existing = inflight.get(code);
  if (existing) return existing;

  const request = (async () => {
    const sourceUrl = twseCompanyFinancialUrl(code);
    try {
      const response = await fetch(sourceUrl, {
        signal: AbortSignal.timeout(10_000),
        cache: 'no-store',
        headers: { 'User-Agent': 'rockstock/1.0', Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`TWSE IIH HTTP ${response.status}`);
      const parsed = parseTwseCompanyFinancials(await response.json(), sourceUrl);
      cache.set(code, {
        value: parsed,
        expiresAt: Date.now() + (parsed ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
      });
      return parsed;
    } catch (error) {
      cache.set(code, { value: null, expiresAt: Date.now() + FAILURE_TTL_MS });
      throw error;
    } finally {
      inflight.delete(code);
    }
  })();

  inflight.set(code, request);
  return request;
}
