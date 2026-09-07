/**
 * 興櫃專用資料鏈。官方成交均價不可與 Yahoo 最後成交價或上市櫃 L1 混接。
 * 原始日行情與 split 事件分開快取；只在回傳圖表前換算價格與股數基準。
 * 官方沒有開收盤價：open/close 均以均價承載，priceBasis 禁止 K 線型態訊號。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Candle } from '@/types';
import { fetchJsonWithCurlFallback } from './curlFetch';
import { expectedTwSymbol } from './twSymbolMarket';
import { getQuoteSnapshotDate, isEmergingPollingWindow } from './marketHours';
import { aggregateCandles } from './aggregateCandles';

const ROOT = path.join(process.env.VERCEL ? os.tmpdir() : process.cwd(), 'data', 'emerging-cache');
const BASE = 'https://www.tpex.org.tw';
const memory = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const DAY = 86_400_000;
export interface EmergingCompany { code: string; name: string }
export interface SplitEvent { date: string; ratio: number }
export interface TpexTable { stat?: string; tables?: Array<{ fields?: string[]; data?: string[][]; subtitle?: string; date?: string }> }

async function cached<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  if (inflight.has(key)) return inflight.get(key) as Promise<T>;
  const promise = (async () => {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(ROOT, `${key}.json`), 'utf8'));
      if (Date.now() - saved.at < ttl) { memory.set(key, saved); return saved.data as T; }
    } catch { /* cache miss */ }
    // 不把失敗或不完整結果當成成功快取，亦不悄悄回退其他價格定義。
    const data = await fetcher();
    const entry = { at: Date.now(), data };
    memory.set(key, entry);
    try {
      await fs.mkdir(ROOT, { recursive: true });
      const file = path.join(ROOT, `${key}.json`);
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(entry));
      await fs.rename(temp, file);
    } catch { /* read-only host: memory cache still works */ }
    return data;
  })();
  inflight.set(key, promise);
  try { return await promise; } finally { inflight.delete(key); }
}

const num = (v: unknown): number => Number(String(v ?? '').replace(/,/g, '').trim());
export function emergingDate(value: string): string | null {
  const raw = value.replace(/\//g, '').replace(/-/g, '');
  if (!/^\d{7,8}$/.test(raw)) return null;
  const year = raw.length === 7 ? Number(raw.slice(0, 3)) + 1911 : Number(raw.slice(0, 4));
  const iso = `${year}-${raw.slice(-4, -2)}-${raw.slice(-2)}`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

export async function resolveEmergingCompany(symbol: string): Promise<EmergingCompany | null> {
  if (!/^\d{4,5}(?:\.TW|\.TWO)?$/i.test(symbol)) return null;
  const code = symbol.split('.')[0];
  // 已知上市櫃股票不新增網路負擔；興櫃名冊每日自動更新，沒有硬編碼個股。
  if (await expectedTwSymbol(`${code}.TW`)) return null;
  const companies = await cached('companies-v1', DAY, async () => {
    const { data } = await fetchJsonWithCurlFallback<Array<Record<string, string>>>(
      `${BASE}/openapi/v1/mopsfin_t187ap03_R`, { timeoutMs: 8000 });
    if (!Array.isArray(data) || !data.length) throw new Error('興櫃公司名冊暫時無法取得');
    const rows = data.filter(r => /^\d{4,5}$/.test(r.SecuritiesCompanyCode ?? '') && r.CompanyAbbreviation)
      .map(r => ({ code: r.SecuritiesCompanyCode, name: r.CompanyAbbreviation }));
    if (!rows.length) throw new Error('興櫃公司名冊欄位異常');
    return rows;
  });
  return companies.find(c => c.code === code) ?? null;
}

export function parseEmergingMonth(json: TpexTable): Candle[] {
  const table = json.tables?.[0];
  const noData = /^查無股票代碼\d{4,5}於\d{3}年\d{2}月之歷史資料/.test(json.stat ?? '');
  if ((!noData && json.stat !== 'ok') || !table || !Array.isArray(table.data)) throw new Error('興櫃歷史行情回應不完整');
  const fields = table.fields ?? [];
  const cols = ['日期', '成交股數', '成交最高', '成交最低', '成交均價'].map(f => fields.indexOf(f));
  if (cols.some(i => i < 0)) throw new Error('興櫃歷史行情欄位異常');
  const result: Candle[] = [];
  for (const row of table.data) {
    const [d, v, h, l, a] = cols.map(i => row[i]);
    const date = emergingDate(d);
    const volume = num(v) / 1000; // 股 → 張；不整數化，保留薄量交易
    if (!(volume > 0)) continue; // 無成交日不可虛構 K 棒
    const high = num(h), low = num(l), close = num(a);
    if (!date || ![high, low, close, volume].every(Number.isFinite) || !(low > 0 && low <= close && close <= high)) {
      throw new Error('興櫃歷史行情含無效成交資料');
    }
    result.push({ date, open: close, high, low, close, volume, priceBasis: 'esb-average' });
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseEmergingSplits(json: unknown, code: string): SplitEvent[] {
  const result = (json as { chart?: { result?: Array<{ meta?: { symbol?: string }; events?: { splits?: Record<string, { date: number; numerator: number; denominator: number }> } }> } }).chart?.result?.[0];
  if (result?.meta?.symbol !== `${code}.TWO`) throw new Error('興櫃換股事件來源代碼不符');
  return Object.values(result.events?.splits ?? {}).map(e => {
    const ratio = e.numerator / e.denominator;
    if (!(Number.isFinite(e.date) && Number.isFinite(ratio) && ratio > 0)) throw new Error('興櫃換股事件格式異常');
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(e.date * 1000));
    return { date, ratio };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

/** 只接受原始官方行情；事件日不調整，回看日期之後的事件不套用，原資料不改寫。 */
export function adjustEmergingCandles(raw: readonly Candle[], events: readonly SplitEvent[], asOf: string): Candle[] {
  return raw.filter(c => c.date <= asOf).map(c => {
    const factor = events.filter(e => c.date < e.date && e.date <= asOf).reduce((f, e) => f * e.ratio, 1);
    return { ...c, open: c.open / factor, high: c.high / factor, low: c.low / factor,
      close: c.close / factor, volume: c.volume * factor };
  });
}

/** 官網分鐘更新表與 OpenAPI 共用同一組欄位定義；不以本機日期冒充資料日期。 */
export function parseEmergingLive(json: TpexTable): Array<Record<string, string>> {
  const table = json.tables?.[0];
  const stamp = /^(\d{3})年(\d{2})月(\d{2})日 (\d{2}):(\d{2}):(\d{2})$/.exec(table?.date ?? '');
  const fields = ['代號', '日最高', '日最低', '日均價', '成交量'];
  const cols = fields.map(f => table?.fields?.indexOf(f) ?? -1);
  if (json.stat !== 'ok' || !stamp || !Array.isArray(table?.data) || cols.some(i => i < 0)) throw new Error('興櫃盤中行情欄位異常');
  return table.data.map(row => ({ SecuritiesCompanyCode: String(row[cols[0]]),
    Highest: String(row[cols[1]]), Lowest: String(row[cols[2]]), Average: String(row[cols[3]]),
    TransactionVolume: String(row[cols[4]]), Date: `${stamp[1]}${stamp[2]}${stamp[3]}`,
    Time: `${stamp[4]}${stamp[5]}${stamp[6]}` }));
}

export async function fetchEmergingQuote(code: string) {
  const rows = await cached('quotes-v2', 60_000, async () => {
    try {
      const { data: live } = await fetchJsonWithCurlFallback<TpexTable>(
        `${BASE}/www/zh-tw/emerging/latest?response=json`, { timeoutMs: 8000 });
      return parseEmergingLive(live);
    } catch { /* 官網暫不可用時，以有日期的 OpenAPI 作備援，不冒充盤中價 */ }
    const { data } = await fetchJsonWithCurlFallback<Array<Record<string, string>>>(
      `${BASE}/openapi/v1/tpex_esb_latest_statistics`, { timeoutMs: 8000 });
    if (!Array.isArray(data) || !data.length) throw new Error('興櫃當日行情暫時無法取得');
    return data;
  });
  const row = rows.find(r => r.SecuritiesCompanyCode === code);
  if (!row) return null;
  const date = emergingDate(row.Date);
  const close = num(row.Average), high = num(row.Highest), low = num(row.Lowest), volume = num(row.TransactionVolume) / 1000;
  if (!date || !(volume > 0 && low > 0 && low <= close && close <= high)) return null;
  const updatedAt = `${date}T${row.Time.slice(0, 2)}:${row.Time.slice(2, 4)}:${row.Time.slice(4, 6)}+08:00`;
  const age = Date.now() - Date.parse(updatedAt);
  const stale = date < getQuoteSnapshotDate('TW') || (isEmergingPollingWindow() && (!Number.isFinite(age) || age > 5 * 60_000));
  return { date, open: close, high, low, close, volume, priceBasis: 'esb-average' as const,
    stale, source: 'tpex-esb', updatedAt };
}

export async function fetchEmergingChart(company: EmergingCompany, period: string, interval: string, asOf?: string) {
  if (!['1d', '1wk', '1mo'].includes(interval)) throw new Error('興櫃官方資料目前僅提供日、週、月行情');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const end = asOf && asOf < today ? asOf : today;
  const start = new Date(`${end}T00:00:00Z`);
  const match = /^(\d+)(y|mo|d)$/.exec(period);
  const amount = match ? Number(match[1]) : 2;
  if (!match || match[2] === 'y') start.setUTCFullYear(start.getUTCFullYear() - Math.min(amount, 10));
  else if (match[2] === 'mo') start.setUTCMonth(start.getUTCMonth() - Math.min(amount, 120));
  else start.setUTCDate(start.getUTCDate() - Math.min(amount, 3650));
  const startDate = start.toISOString().slice(0, 10);
  start.setUTCDate(1);
  const months: string[] = [];
  while (start.toISOString().slice(0, 10) <= end) {
    months.push(start.toISOString().slice(0, 7)); start.setUTCMonth(start.getUTCMonth() + 1);
  }
  const eventsPromise = cached(`splits-v1-${company.code}`, 60 * 60_000, async () => {
    const { data } = await fetchJsonWithCurlFallback<unknown>(
      `https://query1.finance.yahoo.com/v8/finance/chart/${company.code}.TWO?interval=1d&range=max&events=split`, { timeoutMs: 8000, userAgent: 'Mozilla/5.0' });
    return parseEmergingSplits(data, company.code);
  }).then(events => ({ events, available: true }), () => ({ events: [] as SplitEvent[], available: false }));
  const raw: Candle[] = [];
  // 四個月並行，避免長年行情一次打爆櫃買端點。
  for (let i = 0; i < months.length; i += 4) {
    const chunks = await Promise.all(months.slice(i, i + 4).map(month => cached(`month-v1-${company.code}-${month}-${month === today.slice(0, 7) ? 'live' : 'closed'}`,
      month === today.slice(0, 7) ? 60_000 : DAY * 7, async () => {
        const { data } = await fetchJsonWithCurlFallback<TpexTable>(
          `${BASE}/www/zh-tw/emerging/historical?code=${company.code}&date=${month.replace('-', '/')}/01&type=Monthly&response=json`, { timeoutMs: 8000 });
        return parseEmergingMonth(data);
      })));
    raw.push(...chunks.flat());
  }
  // OpenAPI 若仍停在前一日，不覆蓋已存在的完整歷史；盤中僅以同定義均價更新。
  if (end === today) {
    const quote = await fetchEmergingQuote(company.code).catch(() => null);
    if (quote && !quote.stale) {
      const idx = raw.findIndex(c => c.date === quote.date);
      if (idx >= 0) raw[idx] = quote; else raw.push(quote);
    }
  }
  const { events, available } = await eventsPromise;
  const daily = adjustEmergingCandles(raw.sort((a, b) => a.date.localeCompare(b.date)), events, end)
    .filter(c => c.date >= startDate);
  if (!daily.length) throw new Error('此期間沒有興櫃成交資料');
  const candles = (interval === '1d' ? daily : aggregateCandles(daily, interval))
    .map(c => ({ ...c, priceBasis: 'esb-average' as const }));
  return { ticker: `${company.code}.TWO`, name: company.name, currency: 'TWD', interval, candles,
    totalBars: candles.length, source: 'tpex-esb', marketBoard: 'emerging' as const,
    priceBasis: 'esb-average' as const, adjustmentStatus: available ? 'adjusted' : 'unavailable',
    splitEvents: events.filter(e => e.date <= end && e.date >= startDate),
    lastDate: daily.at(-1)!.date, stale: !asOf && daily.at(-1)!.date < getQuoteSnapshotDate('TW') };
}
