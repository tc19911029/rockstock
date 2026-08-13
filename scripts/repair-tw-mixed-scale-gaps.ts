/**
 * repair-tw-mixed-scale 重建後的缺日補回：以官方 raw OHLCV 為基礎，再乘上該月
 * 「目前連續序列 / 官方 raw」最近鄰因子，補成與檔案一致的 raw/調整尺度。
 * 若補後仍形成單日 >35% 往返尖刺，保守跳過並留報告，不編造價格。
 *
 * 用法：npx tsx scripts/repair-tw-mixed-scale-gaps.ts --backup <TW-backup-dir> [--apply]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fetchJsonWithCurlFallback } from '../lib/datasource/curlFetch';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import type { Candle } from '../types';

const APPLY = process.argv.includes('--apply');
const bi = process.argv.indexOf('--backup');
const backupArg = bi >= 0 ? process.argv[bi + 1] : '';
if (!backupArg) throw new Error('Usage: --backup <TW-backup-dir> [--apply]');
const ROOT = process.cwd();
const BACKUP = path.isAbsolute(backupArg) ? backupArg : path.join(ROOT, 'data', 'candles', backupArg);
const DIR = path.join(ROOT, 'data', 'candles', 'TW');
const OUT = path.join(ROOT, 'data', 'reports', `repair-tw-mixed-scale-gaps-${new Date().toISOString().slice(0, 10)}.json`);

type FileData = { symbol?: string; candles: Candle[] };
const round2 = (n: number) => Math.round(n * 100) / 100;
const n = (v: unknown) => Number(String(v ?? '').replace(/,/g, '')) || 0;
const roc = (s: string) => { const m = s.match(/^(\d{3})\/(\d{2})\/(\d{2})$/); return m ? `${+m[1] + 1911}-${m[2]}-${m[3]}` : ''; };

async function tpexMonth(symbol: string, month: string): Promise<Map<string, Candle>> {
  const code = symbol.replace(/\.TWO$/, '');
  const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${month.replace('-', '/')}/01&response=json`;
  const { data } = await fetchJsonWithCurlFallback<{ tables?: Array<{ data?: string[][] }> }>(url, { timeoutMs: 20_000, proxyFirst: true });
  const out = new Map<string, Candle>();
  for (const r of data.tables?.flatMap(t => t.data ?? []) ?? []) {
    const date = roc(r[0]); if (!date || n(r[6]) <= 0) continue;
    out.set(date, { date, open: n(r[3]), high: n(r[4]), low: n(r[5]), close: n(r[6]), volume: Math.round(n(r[1])) });
  }
  return out;
}

async function twseMonth(symbol: string, month: string): Promise<Map<string, Candle>> {
  const code = symbol.replace(/\.TW$/, '');
  // www.twse.com.tw 在長批次容易被 WAF；wwwc 是證交所同站的公開備援 host。
  const url = `https://wwwc.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${month.replace('-', '')}01&stockNo=${code}&response=json`;
  const { data } = await fetchJsonWithCurlFallback<{ data?: string[][] }>(url, { timeoutMs: 20_000 });
  const out = new Map<string, Candle>();
  for (const r of data.data ?? []) {
    const date = roc(r[0]); if (!date || n(r[6]) <= 0) continue;
    out.set(date, { date, open: n(r[3]), high: n(r[4]), low: n(r[5]), close: n(r[6]), volume: Math.round(n(r[1]) / 1000) });
  }
  return out;
}

function nearestFactor(date: string, current: Map<string, Candle>, raw: Map<string, Candle>): number {
  let best = Infinity, factor = 1;
  for (const [d, c] of current) {
    const r = raw.get(d); if (!r || !(r.close > 0 && c.close > 0)) continue;
    const distance = Math.abs(new Date(d).getTime() - new Date(date).getTime());
    if (distance < best) { best = distance; factor = c.close / r.close; }
  }
  return factor;
}

function isolated(candidate: Candle, all: Candle[]): boolean {
  const sorted = [...all, candidate].sort((a, b) => a.date.localeCompare(b.date));
  const i = sorted.findIndex(c => c === candidate), p = sorted[i - 1], nx = sorted[i + 1];
  if (!p || !nx) return false;
  const a = Math.abs(candidate.close / p.close - 1), b = Math.abs(candidate.close / nx.close - 1), neighbours = Math.abs(nx.close / p.close - 1);
  return a > 0.35 && b > 0.35 && neighbours < 0.2;
}

async function main() {
  const files = (await fs.readdir(BACKUP)).filter(f => f.endsWith('.json')).sort();
  const changed: Array<{ symbol: string; date: string; raw: Candle; factor: number; repaired: Candle }> = [];
  const skipped: Array<{ symbol: string; date: string; reason: string }> = [];
  for (const file of files) {
    const symbol = file.slice(0, -5);
    const before = JSON.parse(await fs.readFile(path.join(BACKUP, file), 'utf8')) as FileData;
    const now = JSON.parse(await fs.readFile(path.join(DIR, file), 'utf8')) as FileData;
    const current = new Map(now.candles.map(c => [String(c.date), c]));
    const missing = before.candles.filter(c => !current.has(String(c.date)));
    if (!missing.length) continue;
    const months = [...new Set(missing.map(c => String(c.date).slice(0, 7)))];
    for (const month of months) {
      let raw: Map<string, Candle>;
      try { raw = symbol.endsWith('.TWO') ? await tpexMonth(symbol, month) : await twseMonth(symbol, month); }
      catch (e) { for (const c of missing.filter(x => String(x.date).startsWith(month))) skipped.push({ symbol, date: String(c.date), reason: `official month fetch failed: ${String(e)}` }); continue; }
      for (const old of missing.filter(c => String(c.date).startsWith(month))) {
        let official = raw.get(String(old.date));
        if (!official) { skipped.push({ symbol, date: String(old.date), reason: 'official no-trade/no-row' }); continue; }
        const factor = nearestFactor(String(old.date), current, raw);
        const repaired: Candle = {
          date: String(old.date), open: round2(official.open * factor), high: round2(official.high * factor),
          low: round2(official.low * factor), close: round2(official.close * factor), volume: official.volume,
        };
        if (!(repaired.low > 0 && repaired.low <= repaired.open && repaired.open <= repaired.high && repaired.low <= repaired.close && repaired.close <= repaired.high)) {
          skipped.push({ symbol, date: repaired.date, reason: 'scaled OHLC invalid' }); continue;
        }
        if (isolated(repaired, [...current.values()])) {
          skipped.push({ symbol, date: repaired.date, reason: `scaled candidate remains isolated (factor=${factor})` }); continue;
        }
        current.set(repaired.date, repaired);
        changed.push({ symbol, date: repaired.date, raw: official, factor, repaired });
      }
    }
    if (APPLY && changed.some(x => x.symbol === symbol)) {
      await saveLocalCandles(symbol, 'TW', [...current.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))), { trustedOfficial: true });
    }
  }
  const result = { generatedAt: new Date().toISOString(), apply: APPLY, backup: BACKUP, repaired: changed.length, skipped: skipped.length, changes: changed, skippedDetails: skipped };
  await fs.writeFile(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, changes: changed.slice(0, 20), skippedDetails: skipped.slice(0, 30) }, null, 2));
  if (skipped.length) process.exitCode = 2;
}

main().catch(e => { console.error(e); process.exit(1); });
