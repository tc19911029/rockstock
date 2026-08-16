/**
 * TWSE 發行量加權指數（^TWII）官方歷史日 K。
 *
 * Yahoo 可作備援，但 OHLC 與成交量不應只依賴 Yahoo。TWSE 的
 * MI_5MINS_HIST 提供逐月 OHLC，FMTQIK 提供同月官方成交股數；兩者按日期合併。
 */

import type { Candle } from '@/types';
import { fetchJsonWithCurlFallback } from './curlFetch';
import { fetchTwseMarketStatsMonth } from './TwseMarketStats';

interface TwseIndexResponse {
  stat?: string;
  data?: Array<Array<string | number>>;
}

const MONTH_FETCH_CONCURRENCY = 4;
const CURRENT_MONTH_TTL_MS = 10 * 60 * 1000;
const monthCache = new Map<string, { at: number; candles: Candle[] }>();

function toNum(value: string | number | undefined): number {
  const n = Number.parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function rocToIso(value: string | number | undefined): string | null {
  const match = /^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return `${Number(match[1]) + 1911}-${match[2]}-${match[3]}`;
}

function currentTaipeiMonth(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' })
    .format(new Date())
    .slice(0, 7)
    .replace('-', '');
}

function listMonths(startDate: string, endDate: string): string[] {
  const [startYear, startMonth] = startDate.split('-').map(Number);
  const [endYear, endMonth] = endDate.split('-').map(Number);
  const out: string[] = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}${String(month).padStart(2, '0')}`);
    month++;
    if (month === 13) { year++; month = 1; }
  }
  return out;
}

/** 純解析器：無效 OHLC 不進圖，成交量以官方 FMTQIK 為準。 */
export function mergeTwseIndexMonth(
  response: TwseIndexResponse,
  volumes: Map<string, { volume: number }>,
): Candle[] {
  const candles: Candle[] = [];
  for (const row of response.data ?? []) {
    const date = rocToIso(row[0]);
    const open = toNum(row[1]);
    const high = toNum(row[2]);
    const low = toNum(row[3]);
    const close = toNum(row[4]);
    if (!date || open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    candles.push({
      date,
      open,
      high,
      low,
      close,
      volume: volumes.get(date)?.volume ?? 0,
    });
  }
  return candles.sort((a, b) => a.date.localeCompare(b.date));
}

/** 抓單月官方 ^TWII OHLCV；歷史月永久 cache，當月短 cache。 */
export async function fetchTwseIndexMonth(yyyymm: string): Promise<Candle[]> {
  const cached = monthCache.get(yyyymm);
  const current = yyyymm === currentTaipeiMonth();
  if (cached && (!current || Date.now() - cached.at < CURRENT_MONTH_TTL_MS)) {
    return cached.candles.map((c) => ({ ...c }));
  }

  const [ohlcResult, volumeResult] = await Promise.allSettled([
    fetchJsonWithCurlFallback<TwseIndexResponse>(
      `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${yyyymm}01&response=json`,
      {
        timeoutMs: 15_000,
        headers: { Referer: 'https://www.twse.com.tw/zh/indices/taiex/mi-5min-hist.html' },
      },
    ),
    fetchTwseMarketStatsMonth(yyyymm),
  ]);
  if (ohlcResult.status !== 'fulfilled') {
    console.warn(`[TwseIndexProvider] ${yyyymm} OHLC 抓取失敗:`, ohlcResult.reason);
    return [];
  }
  const volumes = volumeResult.status === 'fulfilled' ? volumeResult.value : new Map();
  if (volumeResult.status !== 'fulfilled') {
    console.warn(`[TwseIndexProvider] ${yyyymm} 成交量抓取失敗，OHLC 仍可用:`, volumeResult.reason);
  }
  const candles = mergeTwseIndexMonth(ohlcResult.value.data, volumes);
  if (candles.length > 0) monthCache.set(yyyymm, { at: Date.now(), candles });
  return candles.map((c) => ({ ...c }));
}

/** 抓指定區間的官方 ^TWII 日 K。 */
export async function fetchTwseIndexCandles(startDate: string, endDate: string): Promise<Candle[]> {
  const months = listMonths(startDate, endDate);
  const all: Candle[] = [];
  for (let i = 0; i < months.length; i += MONTH_FETCH_CONCURRENCY) {
    const results = await Promise.all(months.slice(i, i + MONTH_FETCH_CONCURRENCY).map(fetchTwseIndexMonth));
    for (const rows of results) all.push(...rows);
  }
  return all
    .filter((c) => c.date >= startDate && c.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));
}
