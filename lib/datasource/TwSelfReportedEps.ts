import type { NewsItem } from '@/lib/news/types';
import { fetchYahooTwStockNews } from '@/lib/news/yahooTwStockNews';

export interface TwSelfReportedMonthlyActual {
  period: string;
  revenue: number | null;
  pretaxIncome: number | null;
  netIncome: number | null;
  eps: number;
  announcedAt: string;
  sourceUrl: string;
  source: 'yahoo_tw_mops_republication';
  audited: false;
  note: string;
}

function parseAccountingNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const negative = trimmed.startsWith('(') && trimmed.endsWith(')');
  const value = Number(trimmed.replace(/[(),]/g, ''));
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function firstMonthlyValue(text: string, label: RegExp): number | null {
  const match = text.match(new RegExp(`${label.source}\\s*([()+\\-\\d,.]+)`, 'i'));
  return parseAccountingNumber(match?.[1]);
}

function rocMonthToIso(year: number, month: number): string {
  return `${year + 1911}-${String(month).padStart(2, '0')}`;
}

/** Extract the first (monthly) column from a MOPS attention-stock financial table. */
export function parseSelfReportedMonthlyActual(item: NewsItem): TwSelfReportedMonthlyActual | null {
  const text = `${item.title} ${item.snippet}`.replace(/\s+/g, ' ');
  if (!/注意交易資訊標準/.test(text) || !/財務業務資訊/.test(text)) return null;

  const periodMatch = text.match(/最近一月[\s\S]{0,180}?(\d{2,3})年\s*(\d{1,2})月/);
  const dateMatch = text.match(/日\s*期[：:]\s*(\d{4})年(\d{2})月(\d{2})日/);
  const eps = firstMonthlyValue(text, /每股盈餘(?:（元）)?/);
  if (!periodMatch || !dateMatch || eps == null) return null;

  const revenueMillions = firstMonthlyValue(text, /營業收入/);
  const pretaxMillions = firstMonthlyValue(text, /稅前淨利/);
  const netIncomeMillions = firstMonthlyValue(text, /(?:歸屬母公司業主淨利|歸屬於母公司業主之淨利|稅後淨利)/);

  return {
    period: rocMonthToIso(Number(periodMatch[1]), Number(periodMatch[2])),
    revenue: revenueMillions == null ? null : revenueMillions * 1_000_000,
    pretaxIncome: pretaxMillions == null ? null : pretaxMillions * 1_000_000,
    netIncome: netIncomeMillions == null ? null : netIncomeMillions * 1_000_000,
    eps,
    announcedAt: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
    sourceUrl: item.url,
    source: 'yahoo_tw_mops_republication',
    audited: false,
    note: '注意股重大訊息之單月合併自結數，未經會計師查核或核閱。',
  };
}

export function parseSelfReportedMonthlyActuals(items: NewsItem[]): TwSelfReportedMonthlyActual[] {
  const byPeriod = new Map<string, TwSelfReportedMonthlyActual>();
  for (const item of items) {
    const actual = parseSelfReportedMonthlyActual(item);
    if (!actual) continue;
    const existing = byPeriod.get(actual.period);
    if (!existing || actual.announcedAt > existing.announcedAt) byPeriod.set(actual.period, actual);
  }
  return [...byPeriod.values()].sort((a, b) => b.period.localeCompare(a.period));
}

export async function getTwSelfReportedMonthlyActuals(ticker: string): Promise<TwSelfReportedMonthlyActual[]> {
  return parseSelfReportedMonthlyActuals(await fetchYahooTwStockNews(ticker));
}
