import { getQuoteSnapshotDate, isMarketOpen } from '@/lib/datasource/marketHours';

export type QuoteFreshnessStatus = 'live' | 'provisional-close' | 'final' | 'delayed' | 'no-trade';

export interface QuoteFreshnessAssessment {
  asOf: string | null;
  expectedDate: string;
  stale: boolean;
  status: QuoteFreshnessStatus;
  staleReason?: string;
}

/**
 * 使用者可見報價的新鮮度契約。
 *
 * 盤前／休市預期上一交易日；盤中與同交易日收盤後預期今天。任何早於預期日的
 * 價格都只能標為 delayed，不能再默默冒充最新行情。
 */
export function assessQuoteFreshness(
  market: 'TW' | 'CN',
  asOf: string | null | undefined,
  now = new Date(),
): QuoteFreshnessAssessment {
  const expectedDate = getQuoteSnapshotDate(market, now);
  const normalized = normalizeCalendarDate(asOf);
  // Future dates are provider corruption/clock errors, not fresh data.
  const stale = normalized === null || normalized !== expectedDate;

  if (stale) {
    return {
      asOf: normalized,
      expectedDate,
      stale: true,
      status: 'delayed',
      staleReason: normalized
        ? `行情日期 ${normalized}，目前應為 ${expectedDate}`
        : `行情來源未提供日期，目前應為 ${expectedDate}`,
    };
  }

  return {
    asOf: normalized,
    expectedDate,
    stale: false,
    status: isMarketOpen(market, now) ? 'live' : 'final',
  };
}

function normalizeCalendarDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return value;
}
