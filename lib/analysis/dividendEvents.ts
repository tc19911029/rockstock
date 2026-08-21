export interface CashDividendEvent {
  exDate: string;
  cashDividend: number;
  paymentDate: string | null;
  announcementDate: string | null;
  yearLabel: string | null;
}

interface FinMindDividendRow {
  year?: unknown;
  CashEarningsDistribution?: unknown;
  CashStatutorySurplus?: unknown;
  CashExDividendTradingDate?: unknown;
  CashDividendPaymentDate?: unknown;
  AnnouncementDate?: unknown;
}

const isYmd = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

const finiteNumber = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 把 FinMind 股利列轉成訊號視窗需要的現金除息事件。
 * announcementCutoff 用來避免走圖時偷看到當時尚未公告的未來事件。
 */
export function normalizeCashDividendEvents(
  rows: ReadonlyArray<FinMindDividendRow>,
  fromDate: string,
  toDate: string,
  announcementCutoff: string = fromDate,
): CashDividendEvent[] {
  const byDate = new Map<string, CashDividendEvent>();

  for (const row of rows) {
    const exDate = row.CashExDividendTradingDate;
    const announcementDate = isYmd(row.AnnouncementDate) ? row.AnnouncementDate : null;
    if (!isYmd(exDate) || exDate < fromDate || exDate > toDate) continue;
    if (announcementDate && announcementDate > announcementCutoff) continue;

    const cashDividend = finiteNumber(row.CashEarningsDistribution)
      + finiteNumber(row.CashStatutorySurplus);
    if (!(cashDividend > 0)) continue;

    const existing = byDate.get(exDate);
    byDate.set(exDate, {
      exDate,
      cashDividend: (existing?.cashDividend ?? 0) + cashDividend,
      paymentDate: isYmd(row.CashDividendPaymentDate)
        ? row.CashDividendPaymentDate
        : existing?.paymentDate ?? null,
      announcementDate: announcementDate ?? existing?.announcementDate ?? null,
      yearLabel: typeof row.year === 'string' && row.year.trim()
        ? row.year.trim()
        : existing?.yearLabel ?? null,
    });
  }

  return [...byDate.values()].sort((a, b) => a.exDate.localeCompare(b.exDate));
}

/** 截至 forecastDate 已發生的未來現金除息合計。 */
export function cumulativeCashDividend(
  events: ReadonlyArray<CashDividendEvent>,
  forecastDate: string,
): number {
  return events.reduce(
    (sum, event) => event.exDate <= forecastDate ? sum + event.cashDividend : sum,
    0,
  );
}

/**
 * 原始均線門檻減去期間內現金股息，得到經濟效果相近的「除息等值門檻」。
 * 原始門檻仍保留，避免把會計式參考價下調誤稱成均線真正轉強。
 */
export function cashDividendAdjustedThreshold(
  rawThreshold: number,
  events: ReadonlyArray<CashDividendEvent>,
  forecastDate: string,
): number {
  return Math.max(0, rawThreshold - cumulativeCashDividend(events, forecastDate));
}
