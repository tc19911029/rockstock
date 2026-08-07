import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { TwSelfReportedMonthlyActual } from '@/lib/datasource/TwSelfReportedEps';

export interface SupplementalQuarterActual {
  quarter: string;
  revenue: number | null;
  grossProfit: number | null;
  netIncome: number | null;
  nonRecurringNetIncome: number | null;
  eps: number | null;
  netMargin: number | null;
  grossMargin: number | null;
  announcedAt: string;
  sourceUrl: string;
  note?: string;
}

export interface EarningsGuidance {
  period: string;
  status: 'forecast' | 'preliminary' | 'actual';
  revenueMin?: number | null;
  revenueMax?: number | null;
  netIncomeMin?: number | null;
  netIncomeMax?: number | null;
  normalizedNetIncomeMin?: number | null;
  normalizedNetIncomeMax?: number | null;
  epsMin?: number | null;
  epsMax?: number | null;
  announcedAt: string;
  sourceUrl: string;
  note: string;
}

export interface FundamentalSupplement {
  sharesOutstanding?: number;
  sharesAsOf?: string;
  quarterlyActuals?: SupplementalQuarterActual[];
  latestCumulativeActual?: {
    fiscalYear: number;
    quarter: number;
    reportedThrough: string;
    cumulativeRevenue: number | null;
    cumulativeNetIncome: number | null;
    cumulativeEps: number | null;
    sourceUrl: string;
  };
  selfReportedMonthlyActuals?: TwSelfReportedMonthlyActual[];
  earningsGuidance?: EarningsGuidance[];
  sourceUrls?: Record<string, string>;
}

export async function loadFundamentalSupplement(symbol: string): Promise<FundamentalSupplement | null> {
  const ticker = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const filePath = path.join(process.cwd(), 'data', 'valuation', 'supplemental', `${ticker}.json`);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as FundamentalSupplement;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function mergeQuarterlyActuals<T extends { quarter: string }>(
  reported: T[],
  supplemental: SupplementalQuarterActual[] | undefined,
): Array<T | SupplementalQuarterActual> {
  if (!supplemental?.length) return reported;
  const byQuarter = new Map<string, T | SupplementalQuarterActual>();
  for (const row of reported) byQuarter.set(row.quarter, row);
  for (const row of supplemental) byQuarter.set(row.quarter, row);
  return [...byQuarter.values()].sort((a, b) => b.quarter.localeCompare(a.quarter));
}

export function mergeSelfReportedActuals(
  fetched: TwSelfReportedMonthlyActual[],
  supplemental: TwSelfReportedMonthlyActual[] | undefined,
): TwSelfReportedMonthlyActual[] {
  const byPeriod = new Map<string, TwSelfReportedMonthlyActual>();
  for (const item of [...fetched, ...(supplemental ?? [])]) {
    const prior = byPeriod.get(item.period);
    if (!prior || item.announcedAt > prior.announcedAt) byPeriod.set(item.period, item);
  }
  return [...byPeriod.values()].sort((a, b) => b.period.localeCompare(a.period));
}
