export interface MonthlyFundamentalTrend {
  period: string;
  revenue: number | null;
  revenueMoM: number | null;
  revenueYoY: number | null;
}

export interface QuarterlyFundamentalTrend {
  period: string;
  revenue: number | null;
  revenueQoQ: number | null;
  revenueYoY: number | null;
  grossMargin: number | null;
  grossMarginQoQ: number | null;
  grossMarginYoY: number | null;
  netMargin: number | null;
  netMarginQoQ: number | null;
  netMarginYoY: number | null;
  eps: number | null;
  epsQoQ: number | null;
  epsYoY: number | null;
}

export interface FundamentalTrendHistory {
  market: 'TW' | 'CN';
  monthlyDisclosure: 'available' | 'not-disclosed';
  monthly: MonthlyFundamentalTrend[];
  quarterly: QuarterlyFundamentalTrend[];
  quarterBasis: 'single-quarter' | 'derived-from-cumulative';
  sourceLabel: string;
  sourceUrl?: string | null;
}

export interface SingleQuarterInput {
  period: string;
  revenue?: number | null;
  netIncome?: number | null;
  eps?: number | null;
  /** Accepts either a ratio (0.25) or an already-percent value (25). */
  grossMargin?: number | null;
  /** Accepts either a ratio (0.12) or an already-percent value (12). */
  netMargin?: number | null;
}

export interface CumulativeQuarterInput {
  period: string;
  revenue?: number | null;
  netIncome?: number | null;
  eps?: number | null;
  /** Cumulative gross margin in percent. */
  grossMargin?: number | null;
}

export interface MonthlyRevenueInput {
  period: string;
  revenue?: number | null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function percentMargin(value: number | null | undefined): number | null {
  const number = finite(value);
  if (number == null) return null;
  return Math.abs(number) <= 1 ? number * 100 : number;
}

function growth(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return (current - previous) / Math.abs(previous) * 100;
}

function delta(current: number | null, previous: number | null): number | null {
  return current == null || previous == null ? null : current - previous;
}

function yearAgoPeriod(period: string): string | null {
  const match = period.match(/^(\d{4})(-.+)$/);
  return match ? `${Number(match[1]) - 1}${match[2]}` : null;
}

function previousMonth(period: string): string | null {
  const match = period.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 2, 1));
  return date.toISOString().slice(0, 7);
}

function normalizedMonth(period: string): string {
  return period.slice(0, 7);
}

export function buildMonthlyFundamentalTrends(
  rows: MonthlyRevenueInput[],
): MonthlyFundamentalTrend[] {
  const normalized = rows
    .map(row => ({ period: normalizedMonth(row.period), revenue: finite(row.revenue) }))
    .filter(row => /^\d{4}-\d{2}$/.test(row.period))
    .sort((a, b) => b.period.localeCompare(a.period));
  const byPeriod = new Map(normalized.map(row => [row.period, row.revenue]));

  return normalized.map(row => ({
    ...row,
    revenueMoM: growth(row.revenue, byPeriod.get(previousMonth(row.period) ?? '') ?? null),
    revenueYoY: growth(row.revenue, byPeriod.get(yearAgoPeriod(row.period) ?? '') ?? null),
  }));
}

export function buildSingleQuarterTrends(
  rows: SingleQuarterInput[],
): QuarterlyFundamentalTrend[] {
  const normalized = rows
    .map(row => ({
      period: row.period.slice(0, 10),
      revenue: finite(row.revenue),
      netIncome: finite(row.netIncome),
      eps: finite(row.eps),
      grossMargin: percentMargin(row.grossMargin),
      netMargin: percentMargin(row.netMargin),
    }))
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.period))
    .sort((a, b) => b.period.localeCompare(a.period));
  const byPeriod = new Map(normalized.map(row => [row.period, row]));

  return normalized.map((row, index) => {
    const previous = normalized[index + 1] ?? null;
    const yearAgo = byPeriod.get(yearAgoPeriod(row.period) ?? '') ?? null;
    const netMargin = row.netMargin ?? (
      row.revenue != null && row.revenue !== 0 && row.netIncome != null
        ? row.netIncome / row.revenue * 100
        : null
    );
    const previousNetMargin = previous?.netMargin ?? (
      previous?.revenue != null && previous.revenue !== 0 && previous.netIncome != null
        ? previous.netIncome / previous.revenue * 100
        : null
    );
    const yearAgoNetMargin = yearAgo?.netMargin ?? (
      yearAgo?.revenue != null && yearAgo.revenue !== 0 && yearAgo.netIncome != null
        ? yearAgo.netIncome / yearAgo.revenue * 100
        : null
    );

    return {
      period: row.period,
      revenue: row.revenue,
      revenueQoQ: growth(row.revenue, previous?.revenue ?? null),
      revenueYoY: growth(row.revenue, yearAgo?.revenue ?? null),
      grossMargin: row.grossMargin,
      grossMarginQoQ: delta(row.grossMargin, previous?.grossMargin ?? null),
      grossMarginYoY: delta(row.grossMargin, yearAgo?.grossMargin ?? null),
      netMargin,
      netMarginQoQ: delta(netMargin, previousNetMargin),
      netMarginYoY: delta(netMargin, yearAgoNetMargin),
      eps: row.eps,
      epsQoQ: growth(row.eps, previous?.eps ?? null),
      epsYoY: growth(row.eps, yearAgo?.eps ?? null),
    };
  });
}

/**
 * A-share interim reports are year-to-date cumulative. Convert them to true
 * single-quarter values before calculating QoQ/YoY. Gross profit is derived
 * from cumulative revenue × cumulative margin, then differenced as well.
 */
export function buildCumulativeQuarterTrends(
  rows: CumulativeQuarterInput[],
): QuarterlyFundamentalTrend[] {
  const cumulative = rows
    .map(row => ({
      period: row.period.slice(0, 10),
      revenue: finite(row.revenue),
      netIncome: finite(row.netIncome),
      eps: finite(row.eps),
      grossMargin: percentMargin(row.grossMargin),
    }))
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.period))
    .sort((a, b) => a.period.localeCompare(b.period));

  const single = cumulative.map((row, index): SingleQuarterInput => {
    const year = row.period.slice(0, 4);
    const previous = cumulative[index - 1]?.period.startsWith(year)
      ? cumulative[index - 1]
      : null;
    const subtract = (current: number | null, prior: number | null | undefined) =>
      current == null ? null : previous && prior != null ? current - prior : current;
    const revenue = subtract(row.revenue, previous?.revenue);
    const netIncome = subtract(row.netIncome, previous?.netIncome);
    const eps = subtract(row.eps, previous?.eps);
    const cumulativeGrossProfit = row.revenue != null && row.grossMargin != null
      ? row.revenue * row.grossMargin / 100
      : null;
    const previousGrossProfit = previous?.revenue != null && previous.grossMargin != null
      ? previous.revenue * previous.grossMargin / 100
      : null;
    const grossProfit = subtract(cumulativeGrossProfit, previousGrossProfit);
    const grossMargin = revenue != null && revenue !== 0 && grossProfit != null
      ? grossProfit / revenue * 100
      : null;

    return { period: row.period, revenue, netIncome, eps, grossMargin };
  });

  return buildSingleQuarterTrends(single);
}
