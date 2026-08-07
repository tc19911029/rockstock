import type { FinancialQuarter } from '@/lib/datasource/EastMoneyFinancials';

export interface NormalizedCnQuarter {
  quarter: string;
  revenue: number | null;
  grossProfit: number | null;
  netIncome: number | null;
  nonRecurringNetIncome: number | null;
  eps: number | null;
  netMargin: number | null;
  grossMargin: number | null;
}

function quarterLabel(reportDate: string): string {
  const year = reportDate.slice(0, 4);
  const month = Number(reportDate.slice(5, 7));
  return `${year}Q${Math.max(1, Math.min(4, Math.ceil(month / 3)))}`;
}

function subtractNullable(current: number | null, previous: number | null): number | null {
  if (current == null) return null;
  return previous == null ? current : current - previous;
}

/**
 * EastMoney 季報的營收、淨利與 EPS 是年初至今累計口徑；估值模型需要單季值。
 * Q1 直接採累計值，Q2–Q4 減掉同年度上一報告期，避免把累計 EPS 重複相加。
 */
export function normalizeCnQuarterlyHistory(
  rows: FinancialQuarter[],
  sharesOutstanding: number | null,
): NormalizedCnQuarter[] {
  const sorted = [...rows]
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.reportDate))
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  const byDate = new Map(sorted.map(row => [row.reportDate, row]));

  return sorted.map(row => {
    const year = row.reportDate.slice(0, 4);
    const month = row.reportDate.slice(5, 7);
    const previousDate = month === '06'
      ? `${year}-03-31`
      : month === '09'
        ? `${year}-06-30`
        : month === '12'
          ? `${year}-09-30`
          : null;
    const previous = previousDate ? byDate.get(previousDate) : undefined;
    const revenue = subtractNullable(row.revenue, previous?.revenue ?? null);
    const netIncome = subtractNullable(row.netProfit, previous?.netProfit ?? null);
    const reportedEps = subtractNullable(row.eps, previous?.eps ?? null);
    const eps = netIncome != null && sharesOutstanding != null && sharesOutstanding > 0
      ? netIncome / sharesOutstanding
      : reportedEps;

    return {
      quarter: quarterLabel(row.reportDate),
      revenue,
      grossProfit: null,
      netIncome,
      nonRecurringNetIncome: null,
      eps,
      netMargin: revenue != null && revenue !== 0 && netIncome != null ? netIncome / revenue : null,
      // EastMoney 只提供累計毛利率，不能冒充單季毛利率。
      grossMargin: month === '03' && row.grossMargin != null ? row.grossMargin / 100 : null,
    };
  });
}

/** 最近四個「單季」EPS 加總；任一季缺值就不假裝有完整 TTM。 */
export function sumLatestFourQuarterEps(rows: NormalizedCnQuarter[]): number | null {
  const latestFour = rows.slice(0, 4);
  if (latestFour.length !== 4 || latestFour.some(row => row.eps == null || !Number.isFinite(row.eps))) {
    return null;
  }
  return latestFour.reduce((sum, row) => sum + (row.eps ?? 0), 0);
}
