/**
 * 將 daily-change 稽核抓到的台股異常月份與 TWSE/TPEx 官方月資料交叉核對。
 *
 * 重要：本地歷史可能是拆分調整後價格，不能看到「與官方 raw 不同」就整月覆寫。
 * 本腳本用整段動態規劃，在每個日期選 local/official，使跨日價格序列最連續；只有
 * 官方值能消除 10/100 倍斷層時才採用。如此可修 41.2→4215→42，也不會破壞拆分後
 * 本來連續的調整 K 線。成交量若與官方差 50 倍以上且價格相同，則直接採官方量。
 *
 * 用法：
 *   npx tsx scripts/audit-repair-tw-limit-violations.ts
 *   npx tsx scripts/audit-repair-tw-limit-violations.ts --apply
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fetchJsonWithCurlFallback } from '../lib/datasource/curlFetch';

type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
type MarketViolation = { symbol: string; market: string; date: string };
type ViolationReport = { violations?: MarketViolation[] };
type CandleFile = { symbol: string; lastDate?: string; sealedDate?: string; updatedAt?: string; candles: Candle[] };

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
const DIR = path.join(ROOT, 'data', 'candles', 'TW');
const REPORT = path.join(ROOT, 'data', 'reports', 'l1-daily-change-violations-2026-08-13.json');
const OUT = path.join(ROOT, 'data', 'reports', 'audit-tw-official-limit-violations-2026-08-13.json');
const CONCURRENCY = 8;

class OfficialMonthEmptyError extends Error {}

function num(v: unknown): number {
  const n = Number(String(v ?? '').replace(/,/g, '').replace(/--|---|----/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function rocToIso(v: string): string | null {
  const m = v.match(/^(\d{3})\/(\d{2})\/(\d{2})$/);
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchOfficialOnce(symbol: string, month: string): Promise<Map<string, Candle>> {
  const code = symbol.replace(/\.(TW|TWO)$/i, '');
  const out = new Map<string, Candle>();
  if (symbol.endsWith('.TW')) {
    const ymd = `${month.replace('-', '')}01`;
    const url = `https://wwwc.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ymd}&stockNo=${code}&response=json`;
    const { data } = await fetchJsonWithCurlFallback<{ stat?: string; data?: string[][] }>(url, {
      timeoutMs: 20_000,
    });
    for (const r of data.data ?? []) {
      const date = rocToIso(r[0]);
      const close = num(r[6]);
      if (!date || close <= 0) continue;
      out.set(date, { date, open: num(r[3]), high: num(r[4]), low: num(r[5]), close, volume: Math.round(num(r[1]) / 1000) });
    }
  } else {
    const date = `${month.replace('-', '/')}/01`;
    const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${date}&response=json`;
    const { data } = await fetchJsonWithCurlFallback<{ tables?: Array<{ data?: string[][] }> }>(url, {
      timeoutMs: 20_000,
      proxyFirst: true,
    });
    for (const r of data.tables?.flatMap(t => t.data ?? []) ?? []) {
      const iso = rocToIso(r[0]);
      const close = num(r[6]);
      if (!iso || close <= 0) continue;
      out.set(iso, { date: iso, open: num(r[3]), high: num(r[4]), low: num(r[5]), close, volume: Math.round(num(r[1])) });
    }
  }
  if (out.size === 0) throw new OfficialMonthEmptyError('官方月資料為空（可能尚未上市／當月停牌／市場別歷史已變更）');
  return out;
}

async function fetchOfficial(symbol: string, month: string): Promise<Map<string, Candle>> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await fetchOfficialOnce(symbol, month); }
    catch (e) {
      if (e instanceof OfficialMonthEmptyError) throw e;
      last = e;
      if (attempt < 3) await wait(400 * 2 ** attempt);
    }
  }
  throw last;
}

function same(a: Candle, b: Candle): boolean {
  return a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && Math.abs(a.volume - b.volume) <= 1;
}

function samePrices(a: Candle, b: Candle): boolean {
  return Math.max(
    Math.abs(a.open / b.open - 1), Math.abs(a.high / b.high - 1),
    Math.abs(a.low / b.low - 1), Math.abs(a.close / b.close - 1),
  ) < 0.002;
}

/** 35% 內視為正常/公司事件附近雜訊；超出才以 log 距離懲罰，防止修復器追逐微小差異。 */
function transitionCost(a: Candle, b: Candle): number {
  if (!(a.close > 0 && b.close > 0)) return 1e6;
  const excess = Math.max(0, Math.abs(Math.log(b.close / a.close)) - Math.log(1.35));
  return excess * excess * 100;
}

function chooseSequence(local: Candle[], official: Map<string, Candle>): { candles: Candle[]; changed: Array<{ date: string; local: Candle; official: Candle; reason: string }> } {
  if (!local.length) return { candles: local, changed: [] };
  const choices = local.map(c => {
    const off = official.get(c.date);
    return off && !same(c, off) ? [c, off] : [c];
  });
  const costs: number[][] = choices.map(xs => xs.map(() => Infinity));
  const prevState: number[][] = choices.map(xs => xs.map(() => -1));
  costs[0] = choices[0].map((_, state) => state === 0 ? 0 : 1e-5);
  for (let i = 1; i < choices.length; i++) {
    for (let state = 0; state < choices[i].length; state++) {
      const current = choices[i][state];
      // 價格相同但量相差 ≥50x：官方量是強證據，強制偏好 official。
      const off = official.get(current.date);
      const localBar = local[i];
      const vr = off && localBar.volume > 0 && off.volume > 0
        ? Math.max(localBar.volume / off.volume, off.volume / localBar.volume) : 1;
      const choicePenalty = state === 1 ? (samePrices(localBar, current) && vr >= 50 ? -1 : 1e-5) : 0;
      for (let p = 0; p < choices[i - 1].length; p++) {
        const score = costs[i - 1][p] + transitionCost(choices[i - 1][p], current) + choicePenalty;
        if (score < costs[i][state]) { costs[i][state] = score; prevState[i][state] = p; }
      }
    }
  }
  let state = costs.at(-1)![0] <= (costs.at(-1)![1] ?? Infinity) ? 0 : 1;
  const selected = new Array<Candle>(local.length);
  for (let i = local.length - 1; i >= 0; i--) { selected[i] = choices[i][state]; state = prevState[i][state]; }
  const changed: Array<{ date: string; local: Candle; official: Candle; reason: string }> = [];
  for (let i = 0; i < local.length; i++) {
    if (selected[i] === local[i]) continue;
    changed.push({
      date: local[i].date,
      local: local[i],
      official: selected[i],
      reason: samePrices(local[i], selected[i]) ? 'volume-scale' : 'price-discontinuity',
    });
  }
  return { candles: selected, changed };
}

async function main() {
  const report = JSON.parse(await fs.readFile(REPORT, 'utf8')) as ViolationReport;
  const monthsBySymbol = new Map<string, Set<string>>();
  for (const v of report.violations ?? []) {
    if (v.market !== 'TW') continue;
    const set = monthsBySymbol.get(v.symbol) ?? new Set<string>();
    set.add(v.date.slice(0, 7));
    monthsBySymbol.set(v.symbol, set);
  }
  const symbols = [...monthsBySymbol].sort(([a], [b]) => a.localeCompare(b));
  const mismatches: Array<{ symbol: string; date: string; local: Candle; official: Candle; reason: string }> = [];
  const failures: Array<{ symbol: string; month: string; error: string }> = [];
  let officialBars = 0, changedSymbols = 0, done = 0, cursor = 0;

  async function worker() {
    while (cursor < symbols.length) {
      const [symbol, months] = symbols[cursor++];
      const file = JSON.parse(await fs.readFile(path.join(DIR, `${symbol}.json`), 'utf8')) as CandleFile;
      const official = new Map<string, Candle>();
      for (const month of [...months].sort()) {
        try {
          const rows = await fetchOfficial(symbol, month);
          officialBars += rows.size;
          for (const [date, bar] of rows) official.set(date, bar);
        } catch (e) {
          failures.push({ symbol, month, error: e instanceof Error ? e.message : String(e) });
        }
        await wait(80);
      }
      const result = chooseSequence(file.candles, official);
      if (result.changed.length) {
        mismatches.push(...result.changed.map(x => ({ symbol, ...x })));
        changedSymbols++;
        if (APPLY) {
          file.candles = result.candles;
          file.lastDate = file.candles.at(-1)?.date ?? file.lastDate;
          file.updatedAt = new Date().toISOString();
          await fs.writeFile(path.join(DIR, `${symbol}.json`), JSON.stringify(file));
        }
      }
      done++;
      if (done % 25 === 0 || done === symbols.length) {
        console.log(`[${done}/${symbols.length}] changedBars=${mismatches.length} dirty=${changedSymbols} fail=${failures.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const result = {
    generatedAt: new Date().toISOString(), mode: APPLY ? 'applied' : 'dry-run',
    symbols: symbols.length, pairs: [...monthsBySymbol.values()].reduce((n, s) => n + s.size, 0),
    officialBars, changedBars: mismatches.length, changedSymbols,
    failures: failures.length, failureDetails: failures, changes: mismatches,
  };
  await fs.writeFile(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, changes: undefined, failureDetails: undefined }, null, 2));
  if (failures.length) process.exitCode = 2;
}

main().catch(e => { console.error(e); process.exit(1); });
