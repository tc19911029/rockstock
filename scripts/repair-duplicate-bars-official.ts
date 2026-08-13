/** 用 TWSE/TPEx 官方月資料判定相鄰完整複製 K：官方無該日就刪，官方不同就按既有尺度修正。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Candle } from '../types';
import { fetchJsonWithCurlFallback } from '../lib/datasource/curlFetch';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
const DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
const INPUT = path.join(ROOT, 'data', 'reports', `candle-integrity-complete-${DATE}.json`);
const OUTPUT = path.join(ROOT, 'data', 'reports', `duplicate-bars-official-${DATE}.json`);
const num = (v: unknown) => Number(String(v ?? '').replace(/,/g, '')) || 0;
const roc = (s: string) => { const m = s.match(/^(\d{3})\/(\d{2})\/(\d{2})$/); return m ? `${+m[1] + 1911}-${m[2]}-${m[3]}` : ''; };
const r2 = (x: number) => Math.round(x * 100) / 100;

async function officialMonth(symbol: string, month: string): Promise<Map<string, Candle>> {
  const code = symbol.replace(/\.(TW|TWO)$/, '');
  const isOtc = symbol.endsWith('.TWO');
  const url = isOtc
    ? `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${month.replace('-', '/')}/01&response=json`
    : `https://wwwc.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${month.replace('-', '')}01&stockNo=${code}&response=json`;
  const { data } = await fetchJsonWithCurlFallback<any>(url, { timeoutMs: 20_000, ...(isOtc ? { proxyFirst: true } : {}) });
  const rows: string[][] = isOtc ? (data.tables?.flatMap((t: any) => t.data ?? []) ?? []) : (data.data ?? []);
  const out = new Map<string, Candle>();
  for (const row of rows) {
    const date = roc(row[0]); if (!date || num(row[6]) <= 0) continue;
    out.set(date, { date, open: num(row[3]), high: num(row[4]), low: num(row[5]), close: num(row[6]), volume: Math.round(isOtc ? num(row[1]) : num(row[1]) / 1000) });
  }
  return out;
}

const exact = (a: Candle, b: Candle) => a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

async function main() {
  const audit = JSON.parse(await fs.readFile(INPUT, 'utf8')) as { warnings?: Array<{ market: string; symbol: string; date: string; detail: string }> };
  const candidates = (audit.warnings ?? []).filter(x => x.market === 'TW' && x.detail.startsWith('prev='));
  let legitimate = 0, removed = 0, repaired = 0, failures = 0;
  const details: any[] = [];
  const cache = new Map<string, Map<string, Candle>>();
  for (const c of candidates) {
    const prevDate = c.detail.slice(5), month = c.date.slice(0, 7), key = `${c.symbol}|${month}`;
    let off = cache.get(key);
    try { if (!off) { off = await officialMonth(c.symbol, month); cache.set(key, off); } }
    catch (e) { failures++; details.push({ ...c, action: 'fetch-failed', error: String(e) }); continue; }
    const currentOfficial = off.get(c.date);
    // prev 可能跨月，補抓前月。
    let prevOfficial = off.get(prevDate);
    if (!prevOfficial) {
      const pk = `${c.symbol}|${prevDate.slice(0, 7)}`;
      try { let pm = cache.get(pk); if (!pm) { pm = await officialMonth(c.symbol, prevDate.slice(0, 7)); cache.set(pk, pm); } prevOfficial = pm.get(prevDate); }
      catch { /* 下方視為資料不足 */ }
    }
    const local = await readCandleFile(c.symbol, 'TW');
    if (!local) { failures++; continue; }
    if (!currentOfficial) {
      const next = local.candles.filter(x => x.date !== c.date);
      if (APPLY) await saveLocalCandles(c.symbol, 'TW', next, { trustedOfficial: true, replaceExisting: true });
      removed++; details.push({ ...c, action: 'remove-non-trading-date' }); continue;
    }
    if (prevOfficial && exact(prevOfficial, currentOfficial)) {
      legitimate++; details.push({ ...c, action: 'confirmed-legitimate' }); continue;
    }
    if (!prevOfficial) { failures++; details.push({ ...c, action: 'missing-official-prev' }); continue; }
    const localPrev = local.candles.find(x => x.date === prevDate);
    const factor = localPrev && prevOfficial.close > 0 ? localPrev.close / prevOfficial.close : 1;
    const fixedPrev: Candle = { date: prevDate, open: r2(prevOfficial.open * factor), high: r2(prevOfficial.high * factor), low: r2(prevOfficial.low * factor), close: r2(prevOfficial.close * factor), volume: prevOfficial.volume };
    const fixed: Candle = { date: c.date, open: r2(currentOfficial.open * factor), high: r2(currentOfficial.high * factor), low: r2(currentOfficial.low * factor), close: r2(currentOfficial.close * factor), volume: currentOfficial.volume };
    // 假複製有時是前一日 volume 先被污染，僅覆寫當日仍會維持 byte-identical；
    // 兩天都以同一官方尺度修正，才不會留下「修復成功」的假象。
    if (APPLY) await saveLocalCandles(c.symbol, 'TW', [fixedPrev, fixed], { trustedOfficial: true });
    repaired++; details.push({ ...c, action: 'repair-official', factor, fixedPrev, fixed });
  }
  const result = { generatedAt: new Date().toISOString(), apply: APPLY, candidates: candidates.length, legitimate, removed, repaired, failures, details };
  await fs.writeFile(OUTPUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, details: details.slice(0, 20) }, null, 2));
  if (failures) process.exitCode = 2;
}
main().catch(e => { console.error(e); process.exit(1); });
