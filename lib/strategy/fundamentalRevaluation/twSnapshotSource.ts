/**
 * 台股 V 策略的官方／本地快照來源。
 *
 * 歷史資料讀既有 data/_finmind bulk 快照；最新月營收、季報、股本與產業以
 * TWSE/TPEx 全市場 OpenAPI 補齊。正常日掃描不再做任何 per-stock FinMind request。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  getCompanyAny,
  getMonthlyAny,
  getQuarterlyAny,
  type TwseQuarterly,
} from '@/lib/datasource/TwseOpenApiProvider';
import {
  normalizeRevenuePeriod,
  type BalanceSheetData,
  type QuarterlyHistoryRow,
  type RevenueRow,
  type StockInfoData,
} from '@/lib/datasource/FinMindClient';

interface CachedRows<T> {
  rows?: T[];
}

interface CachedFinancialRow {
  date: string;
  type: string;
  value: number;
}

const CACHE_ROOT = path.join(process.cwd(), 'data', '_finmind');

let revenueMapPromise: Promise<Map<string, RevenueRow[]>> | null = null;

function numberOrNull(value: unknown): number | null {
  if (value == null || String(value).trim() === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

async function readCachedRows<T>(filePath: string): Promise<T[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as CachedRows<T>;
    return Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
}

export function financialRowsToQuarterHistory(
  rows: CachedFinancialRow[],
  limit = 8,
): QuarterlyHistoryRow[] {
  const byDate = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!row.date || !row.type || !Number.isFinite(row.value)) continue;
    if (!byDate.has(row.date)) byDate.set(row.date, new Map());
    byDate.get(row.date)!.set(row.type, row.value);
  }
  return [...byDate.keys()]
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit)
    .map((quarter) => {
      const metrics = byDate.get(quarter)!;
      const revenue = metrics.get('Revenue') ?? null;
      const grossProfit = metrics.get('GrossProfit') ?? null;
      const netIncome = metrics.get('IncomeAfterTaxes') ?? null;
      const eps = metrics.get('EPS') ?? null;
      return {
        quarter,
        revenue,
        grossProfit,
        netIncome,
        eps,
        netMargin: revenue && netIncome != null ? netIncome / revenue : null,
        grossMargin: revenue && grossProfit != null ? grossProfit / revenue : null,
      };
    });
}

function quarterEndDate(year: number, season: number): string {
  return `${year}-${String(season * 3).padStart(2, '0')}-${season === 1 || season === 4 ? '31' : '30'}`;
}

/** 將官方累計季報轉成單季口徑，再與本地歷史合併。 */
export function mergeOfficialQuarter(
  history: QuarterlyHistoryRow[],
  official: TwseQuarterly | null,
): QuarterlyHistoryRow[] {
  if (!official || official.rocYear <= 0 || official.season < 1 || official.season > 4) return history;
  const year = official.rocYear + 1911;
  const date = quarterEndDate(year, official.season);
  if (history.some((row) => row.quarter === date)) return history;

  const earlier = history.filter((row) => row.quarter.startsWith(`${year}-`) && row.quarter < date);
  if (official.season > 1 && earlier.length < official.season - 1) return history;
  const subtract = (cumulative: number | null, field: 'eps' | 'revenue' | 'netIncome'): number | null => {
    if (cumulative == null) return null;
    const previous = earlier.reduce((sum, row) => sum + (row[field] ?? 0), 0);
    const value = cumulative - previous;
    return field === 'eps' ? +value.toFixed(6) : value;
  };
  const revenue = subtract(official.revenue == null ? null : official.revenue * 1000, 'revenue');
  const netIncome = subtract(official.netIncome == null ? null : official.netIncome * 1000, 'netIncome');
  const eps = subtract(official.eps, 'eps');
  const row: QuarterlyHistoryRow = {
    quarter: date,
    revenue,
    grossProfit: null,
    netIncome,
    eps,
    netMargin: revenue && netIncome != null ? netIncome / revenue : null,
    grossMargin: null,
  };
  return [row, ...history].sort((a, b) => b.quarter.localeCompare(a.quarter)).slice(0, 8);
}

async function loadRevenueMap(): Promise<Map<string, RevenueRow[]>> {
  if (revenueMapPromise) return revenueMapPromise;
  revenueMapPromise = (async () => {
    const map = new Map<string, RevenueRow[]>();
    try {
      const dir = path.join(CACHE_ROOT, 'revenue');
      const files = (await fs.readdir(dir)).filter((file) => /^\d{4}-\d{2}\.json$/.test(file)).sort().slice(-26);
      for (const file of files) {
        const rows = await readCachedRows<RevenueRow>(path.join(dir, file));
        for (const raw of rows) {
          const row = normalizeRevenuePeriod(raw);
          if (!map.has(row.stock_id)) map.set(row.stock_id, []);
          map.get(row.stock_id)!.push(row);
        }
      }
      for (const rows of map.values()) rows.sort((a, b) => b.date.localeCompare(a.date));
    } catch {
      // 官方最新月資料仍可讓個股降級運作；完整性守門會阻止市場整片空白寫盤。
    }
    return map;
  })();
  return revenueMapPromise;
}

function mergeOfficialMonth(history: RevenueRow[], official: Awaited<ReturnType<typeof getMonthlyAny>>): RevenueRow[] {
  const match = official?.yearMonth.match(/^(\d{3})(\d{2})$/);
  if (!official || !match || official.revenue == null) return history.slice(0, 24);
  const revenueYear = Number(match[1]) + 1911;
  const revenueMonth = Number(match[2]);
  const period = `${revenueYear}-${String(revenueMonth).padStart(2, '0')}-01`;
  const latest: RevenueRow = {
    date: period,
    stock_id: official.code,
    revenue: official.revenue * 1000,
    revenue_year: revenueYear,
    revenue_month: revenueMonth,
  };
  return [latest, ...history.filter((row) => normalizeRevenuePeriod(row).date !== period)]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 24);
}

async function loadLocalQuarters(symbol: string): Promise<QuarterlyHistoryRow[]> {
  const rows = await readCachedRows<CachedFinancialRow>(path.join(CACHE_ROOT, 'financials', `${symbol}.json`));
  return financialRowsToQuarterHistory(rows);
}

async function loadLocalBalance(symbol: string, shares: number | null): Promise<BalanceSheetData | null> {
  const rows = await readCachedRows<CachedFinancialRow>(path.join(CACHE_ROOT, 'balancesheet', `${symbol}.json`));
  const dates = [...new Set(rows.map((row) => row.date).filter(Boolean))].sort((a, b) => b.localeCompare(a));
  const date = dates[0];
  if (!date) return null;
  const latest = new Map(rows.filter((row) => row.date === date).map((row) => [row.type, row.value]));
  const equity = numberOrNull(latest.get('Equity') ?? latest.get('TotalEquity'));
  return {
    date,
    equity,
    bookValuePerShare: equity != null && shares != null && shares > 0 ? equity / shares : null,
  };
}

const INDUSTRY_NAMES: Record<string, string> = {
  '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維',
  '05': '電機機械', '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙工業',
  '10': '鋼鐵工業', '11': '橡膠工業', '12': '汽車工業', '14': '建材營造',
  '15': '航運業', '16': '觀光餐旅', '17': '金融保險', '18': '貿易百貨',
  '20': '其他業', '21': '化學工業', '22': '生技醫療', '23': '油電燃氣',
  '24': '半導體業', '25': '電腦及週邊設備業', '26': '光電業', '27': '通信網路業',
  '28': '電子零組件業', '29': '電子通路業', '30': '資訊服務業', '31': '其他電子業',
  '32': '文化創意業', '33': '農業科技業', '34': '電子商務', '35': '綠能環保',
  '36': '數位雲端', '37': '運動休閒', '38': '居家生活',
};

export interface TwFundamentalSnapshot {
  revenueRows: RevenueRow[];
  quarterRows: QuarterlyHistoryRow[];
  shares: number | null;
  balance: BalanceSheetData | null;
  info: StockInfoData | null;
}

export async function loadTwFundamentalSnapshot(symbol: string): Promise<TwFundamentalSnapshot> {
  const [revenueMap, localQuarters, officialQuarter, officialMonth, company] = await Promise.all([
    loadRevenueMap(),
    loadLocalQuarters(symbol),
    getQuarterlyAny(symbol),
    getMonthlyAny(symbol),
    getCompanyAny(symbol),
  ]);
  const quarterRows = mergeOfficialQuarter(localQuarters, officialQuarter);
  const inferredShares = (() => {
    const latest = quarterRows.find((row) => row.netIncome != null && row.eps != null && Math.abs(row.eps) > 0.01);
    return latest?.netIncome != null && latest.eps != null ? Math.abs(latest.netIncome / latest.eps) : null;
  })();
  const shares = company?.issuedShares ?? inferredShares;
  const balance = await loadLocalBalance(symbol, shares);
  const industry = officialQuarter?.industry || (company?.industry ? INDUSTRY_NAMES[company.industry] ?? company.industry : '');
  return {
    revenueRows: mergeOfficialMonth(revenueMap.get(symbol) ?? [], officialMonth),
    quarterRows,
    shares,
    balance,
    info: company ? {
      stock_id: symbol,
      stock_name: company.name,
      industry_category: industry,
      market_type: company.marketType,
    } : null,
  };
}
