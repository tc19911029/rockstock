import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { fetchJsonWithCurlFallback } from './curlFetch';
import type { GovernanceData } from './FinMindClient';

type Row = { code: string; pct: number; remaining: number | null; date: string };
const TWSE = 'https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?selectType=ALLBUT0999&response=json';
const TPEX = 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_qfii';
function number(value: unknown): number | null {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/[,%]/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}
export function parseOwnership(payload: unknown, market: 'TWSE' | 'TPEx'): Row[] {
  const result: Row[] = [];
  const p = payload as Record<string, unknown>;
  const rows = market === 'TWSE' ? p?.data : payload;
  if (!Array.isArray(rows)) return [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const code = String(market === 'TWSE' ? row[0] : r.SecuritiesCompanyCode);
    const rawDate = String(market === 'TWSE' ? p.date : r.Date);
    const digits = rawDate.replace(/\D/g, '');
    const normalized = digits.length === 7 ? String(Number(digits.slice(0, 3)) + 1911) + digits.slice(3) : digits;
    const date = normalized.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    const pct = number(market === 'TWSE' ? row[7] : r['PercentageOfSharesOC/FMIHeld']);
    const remaining = number(market === 'TWSE' ? row[6] : r['PercentageOfAvailableInvestmentForOC/FI']);
    if (/^\d{4,6}$/.test(code) && /^\d{4}-\d{2}-\d{2}$/.test(date) && pct !== null) result.push({ code, pct, remaining, date });
  }
  return result;
}
type OwnershipRow = Row & { source: string; baseline: number | null };
let pending: Promise<OwnershipRow[]> | null = null;
let expires = 0;
function historyPath(market: string, date: string): string {
  return path.join(process.cwd(), 'data', 'official-ownership', market, `${date}.json`);
}
async function cachedBaseline(market: string, date: string): Promise<Map<string, number>> {
  if (process.env.NODE_ENV === 'test') return new Map();
  try {
    const data = JSON.parse(await fs.readFile(historyPath(market, date), 'utf8')) as { date: string; rows: Array<{ code: string; pct: number }> };
    if (data.date !== date) return new Map();
    return new Map(data.rows.filter(r => /^\d{4,6}$/.test(r.code) && number(r.pct) !== null).map(r => [r.code, r.pct]));
  } catch { return new Map(); }
}
async function saveBaseline(market: string, date: string, rows: Map<string, number>, source: string): Promise<void> {
  if (process.env.NODE_ENV === 'test' || !rows.size) return;
  const file = historyPath(market, date);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicFsPut(file, JSON.stringify({ date, source, fetchedAt: new Date().toISOString(), rows: [...rows].map(([code, pct]) => ({ code, pct })) }));
  } catch { /* A disk cache failure must not discard a valid official response. */ }
}

export async function getOfficialOwnership(code: string): Promise<{ data: GovernanceData; source: string } | null> {
  if (!pending || Date.now() >= expires) {
    expires = Date.now() + 3600_000;
    pending = Promise.allSettled(([['TWSE', TWSE], ['TPEx', TPEX]] as const).map(async ([market, url]) => {
      let currentUrl: string = url;
      let rows: Row[] = [];
      try {
        const { data } = await fetchJsonWithCurlFallback(currentUrl, { proxyFirst: true, timeoutMs: 12_000 });
        rows = parseOwnership(data, market);
      } catch (error) { if (market !== 'TWSE') throw error; }
      // TWSE's default date can be today before publication. Ask preceding dates explicitly.
      if (market === 'TWSE' && rows.length === 0) {
        const taipeiDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
        for (let days = 1; days <= 7 && rows.length === 0; days++) {
          const date = new Date(Date.parse(taipeiDate) - days * 86400_000).toISOString().slice(0, 10);
          if ([0, 6].includes(new Date(date).getUTCDay())) continue;
          currentUrl = TWSE.replace('?', `?date=${date.replace(/-/g, '')}&`);
          const retry = await fetchJsonWithCurlFallback(currentUrl, { proxyFirst: true, timeoutMs: 12_000 });
          rows = parseOwnership(retry.data, market).filter(row => row.date === date);
        }
      }
      if (!rows.length) throw new Error('Official ownership not published');
      const date = rows[0]?.date;
      let baseline = new Map<string, number>();
      let baselineUrl = '';
      if (date) {
        const target = new Date(Date.parse(date) - 28 * 86400_000).toISOString().slice(0, 10);
        baselineUrl = market === 'TWSE' ? TWSE.replace('?', `?date=${target.replace(/-/g, '')}&`)
          : 'https://www.tpex.org.tw/www/zh-tw/insti/qfii?' + new URLSearchParams({ date: target.replace(/-/g, '/'), type: 'EW', response: 'json' });
        baseline = await cachedBaseline(market, target);
        const hadCachedBaseline = baseline.size > 0;
        if (!hadCachedBaseline) try {
          const request = () => fetchJsonWithCurlFallback<Record<string, unknown>>(baselineUrl, { proxyFirst: true, timeoutMs: 12_000 });
          const response = await request().catch(() => request());
          if (market === 'TWSE') {
            for (const row of parseOwnership(response.data, market)) if (row.date === target) baseline.set(row.code, row.pct);
          } else {
            const tables = response.data.tables as Array<{ date?: string; data?: unknown[][] }> | undefined;
            const expected = `${Number(target.slice(0, 4)) - 1911}/${target.slice(5).replace('-', '/')}`;
            for (const table of tables ?? []) if (table.date === expected) for (const r of table.data ?? []) {
              const pct = number(r[7]);
              if (pct !== null) baseline.set(String(r[1]), pct);
            }
          }
        } catch { expires = Math.min(expires, Date.now() + 60_000); /* Keep current data and retry unavailable history soon. */ }
        if (!hadCachedBaseline) await saveBaseline(market, target, baseline, baselineUrl);
        await saveBaseline(market, date, new Map(rows.map(row => [row.code, row.pct])), currentUrl);
      }
      return rows.map(row => ({ ...row, source: baseline.has(row.code) ? `${currentUrl} | ${baselineUrl}` : currentUrl, baseline: baseline.get(row.code) ?? null }));
    })).then(results => {
      if (results.some(r => r.status === 'rejected')) expires = Date.now() + 60_000;
      return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    });
  }
  const row = (await pending).find(r => r.code === code);
  if (!row) return null;
  return { source: row.source, data: {
    foreign_ownership_pct: row.pct, foreign_remaining_ratio: row.remaining, data_date: row.date,
    foreign_ownership_pct_4w_ago: row.baseline, foreign_ownership_delta_4w: row.baseline === null ? null : Number((row.pct - row.baseline).toFixed(4)),
  } };
}
