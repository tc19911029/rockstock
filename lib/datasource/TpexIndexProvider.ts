/**
 * TPEx 櫃買指數（^TWOII）官方日 K。
 *
 * Yahoo 的 ^TWOII chart feed 自 2024-10 後只剩 null bar，不能拿來做每日更新。
 * TPEx 官方月查詢提供 OHLC，afterTrading/tradingIndex 提供同月成交張數；兩者按日期合併。
 */

import type { Candle } from '@/types';
import { fetchJsonWithCurlFallback } from './curlFetch';

interface TpexTableResponse {
  stat?: string;
  tables?: Array<{
    data?: Array<Array<string | number>>;
  }>;
}

const MONTH_FETCH_CONCURRENCY = 4;
const CURRENT_MONTH_TTL_MS = 10 * 60 * 1000;
const monthCache = new Map<string, { at: number; candles: Candle[] }>();

function toNum(value: string | number | undefined): number {
  const n = Number.parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function normalizeDate(value: string | number | undefined): string | null {
  const raw = String(value ?? '').trim();
  const iso = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const roc = /^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec(raw);
  if (roc) return `${Number(roc[1]) + 1911}-${roc[2]}-${roc[3]}`;
  return null;
}

function monthKey(date: string): string {
  return date.slice(0, 7).replace('-', '');
}

function currentTaipeiMonth(): string {
  return monthKey(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()));
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

/** 抓單月官方 ^TWOII OHLCV；過去月份永久 cache，當月短 cache。 */
export async function fetchTpexIndexMonth(yyyymm: string): Promise<Candle[]> {
  const cached = monthCache.get(yyyymm);
  const isCurrentMonth = yyyymm === currentTaipeiMonth();
  if (cached && (!isCurrentMonth || Date.now() - cached.at < CURRENT_MONTH_TTL_MS)) {
    return cached.candles.map((c) => ({ ...c }));
  }

  const year = yyyymm.slice(0, 4);
  const month = yyyymm.slice(4, 6);
  const date = `${year}/${month}/01`;
  const [ohlcResult, volumeResult] = await Promise.allSettled([
    fetchJsonWithCurlFallback<TpexTableResponse>(
      `https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=${date}&response=json`,
      { timeoutMs: 15_000 },
    ),
    fetchJsonWithCurlFallback<TpexTableResponse>(
      `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=${date}&response=json`,
      { timeoutMs: 15_000 },
    ),
  ]);

  if (ohlcResult.status !== 'fulfilled') {
    console.warn(`[TpexIndexProvider] ${yyyymm} OHLC 抓取失敗:`, ohlcResult.reason);
    return [];
  }

  const volumeResponse = volumeResult.status === 'fulfilled' ? volumeResult.value.data : undefined;
  if (volumeResult.status !== 'fulfilled') {
    console.warn(`[TpexIndexProvider] ${yyyymm} 成交量抓取失敗，拒絕輸出不完整 OHLCV:`, volumeResult.reason);
  }
  const candles = mergeTpexIndexTables(ohlcResult.value.data, volumeResponse);
  if (candles.length > 0) monthCache.set(yyyymm, { at: Date.now(), candles });
  return candles.map((c) => ({ ...c }));
}

/** 純解析器，讓官方 schema 契約可不打網路測試。 */
export function mergeTpexIndexTables(
  ohlcResponse: TpexTableResponse,
  volumeResponse?: TpexTableResponse,
): Candle[] {
  const volumes = new Map<string, number>();
  if (volumeResponse) {
    for (const row of volumeResponse.tables?.[0]?.data ?? []) {
      const rowDate = normalizeDate(row[0]);
      const volume = toNum(row[1]); // 官方欄位「成交張數」，已與 TW L1 單位一致
      if (rowDate && volume > 0) volumes.set(rowDate, volume);
    }
  }

  const candles: Candle[] = [];
  for (const row of ohlcResponse.tables?.[0]?.data ?? []) {
    const rowDate = normalizeDate(row[0]);
    const open = toNum(row[1]);
    const high = toNum(row[2]);
    const low = toNum(row[3]);
    const close = toNum(row[4]);
    if (!rowDate || open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    const volume = volumes.get(rowDate);
    if (!volume || volume <= 0) continue;
    candles.push({ date: rowDate, open, high, low, close, volume });
  }
  candles.sort((a, b) => a.date.localeCompare(b.date));
  return candles;
}

/** 抓指定區間的官方 ^TWOII 日 K。 */
export async function fetchTpexIndexCandles(startDate: string, endDate: string): Promise<Candle[]> {
  const months = listMonths(startDate, endDate);
  const all: Candle[] = [];
  for (let i = 0; i < months.length; i += MONTH_FETCH_CONCURRENCY) {
    const results = await Promise.all(months.slice(i, i + MONTH_FETCH_CONCURRENCY).map(fetchTpexIndexMonth));
    for (const candles of results) all.push(...candles);
  }
  return all.filter((c) => c.date >= startDate && c.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));
}
