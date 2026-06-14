#!/usr/bin/env npx tsx
/**
 * finmind-fetch-datasets.ts — 用 FinMind 會員額度批量下載「各種台股資料集」全歷史。
 *
 * 三種模式（registry 指定）：
 *   by-date   一天一個請求抓全市場（不帶 data_id）→ data/_finmind/{key}/{date}.json
 *   by-month  一月一個請求（月營收）              → data/_finmind/{key}/{YYYY-MM}.json
 *   per-stock 一檔一個請求抓全年份（財報/資產負債）→ data/_finmind/{key}/{code}.json
 *
 * 特性：併發池（預設 8）、skip 已存在、402/429 退避重試、過濾到真股票宇宙（去權證）。
 * 交易日清單沿用已下載的 data/_finmind/TW/{date}.json（tradingDay=true）。
 *
 * 用法：
 *   npx tsx scripts/finmind-fetch-datasets.ts                 # 全部(不含分點)
 *   npx tsx scripts/finmind-fetch-datasets.ts institutional margin per   # 只跑指定
 *   npx tsx scripts/finmind-fetch-datasets.ts --list          # 列出所有 key
 *   npx tsx scripts/finmind-fetch-datasets.ts --from 2021-01-01 --conc 8 [--force]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const REPO = process.cwd();
const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';
const FM_ROOT = path.join(REPO, 'data', '_finmind');
const PRICE_DIR = path.join(FM_ROOT, 'TW');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── registry ───────────────────────────────────────────────────────────────────
type Mode = 'by-date' | 'by-month' | 'per-stock';
interface DS {
  ds: string;
  mode: Mode;
  filter: boolean; // 過濾到真股票宇宙
  label: string;
}
const DATASETS: Record<string, DS> = {
  institutional: { ds: 'TaiwanStockInstitutionalInvestorsBuySell', mode: 'by-date', filter: true, label: '三大法人買賣超' },
  margin: { ds: 'TaiwanStockMarginPurchaseShortSale', mode: 'by-date', filter: true, label: '融資融券' },
  daytrade: { ds: 'TaiwanStockDayTrading', mode: 'by-date', filter: true, label: '當沖' },
  sbl: { ds: 'TaiwanStockSecuritiesLending', mode: 'by-date', filter: true, label: '借券' },
  holders: { ds: 'TaiwanStockHoldingSharesPer', mode: 'by-date', filter: true, label: '集保大戶持股分級' },
  per: { ds: 'TaiwanStockPER', mode: 'by-date', filter: true, label: '本益比/淨值比/殖利率' },
  marketvalue: { ds: 'TaiwanStockMarketValue', mode: 'by-date', filter: true, label: '市值' },
  shareholding: { ds: 'TaiwanStockShareholding', mode: 'by-date', filter: true, label: '外資持股比率' },
  dividend: { ds: 'TaiwanStockDividend', mode: 'by-date', filter: true, label: '除權息' },
  total_margin: { ds: 'TaiwanStockTotalMarginPurchaseShortSale', mode: 'by-date', filter: false, label: '大盤融資券' },
  total_inst: { ds: 'TaiwanStockTotalInstitutionalInvestors', mode: 'by-date', filter: false, label: '大盤三大法人' },
  revenue: { ds: 'TaiwanStockMonthRevenue', mode: 'by-month', filter: true, label: '月營收' },
  financials: { ds: 'TaiwanStockFinancialStatements', mode: 'per-stock', filter: false, label: '財報(損益)' },
  balancesheet: { ds: 'TaiwanStockBalanceSheet', mode: 'per-stock', filter: false, label: '資產負債表' },
};

// ── token / args ─────────────────────────────────────────────────────────────
function loadToken(): string {
  const p = path.join(REPO, '.env.local');
  if (!existsSync(p)) return '';
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const m = line.match(/^FINMIND_API_TOKEN\s*=\s*(.+)$/);
    if (m) return m[1].replace(/['"]/g, '').trim();
  }
  return '';
}
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const flags = new Set(a.filter((x) => x.startsWith('--')));
  const keys = a.filter((x) => !x.startsWith('--') && DATASETS[x]);
  // 消費掉 --from/--to/--conc 的值，避免被當 key
  const consumed = new Set<string>();
  for (const k of ['--from', '--to', '--conc']) {
    const i = a.indexOf(k);
    if (i >= 0) consumed.add(a[i + 1]);
  }
  return {
    keys: keys.filter((k) => !consumed.has(k)),
    from: get('--from') ?? '2021-01-01',
    to: get('--to'),
    conc: get('--conc') ? parseInt(get('--conc')!, 10) : 8,
    force: flags.has('--force'),
    list: flags.has('--list'),
  };
}

function loadUniverse(): Set<string> {
  const dir = path.join(REPO, 'data', 'candles', 'TW');
  const s = new Set<string>();
  if (existsSync(dir))
    for (const f of readdirSync(dir))
      if (f.endsWith('.json')) s.add(f.replace(/\.(TW|TWO)\.json$/i, '').replace(/\.json$/i, ''));
  return s;
}
function keepCode(code: string, uni: Set<string>): boolean {
  return uni.has(code) || /^\d{4,5}$/.test(code);
}

function tradingDays(from: string, to?: string): string[] {
  if (!existsSync(PRICE_DIR)) {
    console.error('❌ 找不到 data/_finmind/TW（先跑 finmind-bulk-prices.ts 建交易日清單）');
    process.exit(1);
  }
  const days: string[] = [];
  for (const f of readdirSync(PRICE_DIR)) {
    if (!f.endsWith('.json')) continue;
    const date = f.replace('.json', '');
    if (date < from) continue;
    if (to && date > to) continue;
    try {
      const d = JSON.parse(readFileSync(path.join(PRICE_DIR, f), 'utf-8'));
      if (d.tradingDay) days.push(date);
    } catch { /* skip */ }
  }
  return days.sort();
}
function months(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function fmFetch(token: string, ds: string, params: Record<string, string>): Promise<any[] | null> {
  const u = new URL(FINMIND_API);
  u.searchParams.set('dataset', ds);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('token', token);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(u.toString(), { signal: AbortSignal.timeout(40000) });
      if (res.status === 402 || res.status === 429) {
        await sleep(45000);
        continue;
      }
      if (!res.ok) {
        await sleep(2500);
        continue;
      }
      const j = (await res.json()) as { status: number; data?: any[] };
      if (j.status !== 200) {
        await sleep(2500);
        continue;
      }
      return j.data ?? [];
    } catch {
      await sleep(2500);
    }
  }
  return null;
}

// 簡單併發池
async function runPool<T>(items: T[], conc: number, worker: (item: T, i: number) => Promise<void>): Promise<void> {
  let idx = 0;
  const runners = Array.from({ length: Math.min(conc, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

async function runDataset(key: string, token: string, uni: Set<string>, opts: ReturnType<typeof parseArgs>) {
  const cfg = DATASETS[key];
  const outDir = path.join(FM_ROOT, key);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const to = opts.to ?? today;

  let units: string[];
  if (cfg.mode === 'by-date') units = tradingDays(opts.from, to);
  else if (cfg.mode === 'by-month') units = months(opts.from.slice(0, 7), to.slice(0, 7));
  else units = [...uni].filter((c) => keepCode(c, uni)).sort(); // per-stock

  console.log(`\n▶ ${key} (${cfg.label}) [${cfg.mode}] — ${units.length} 個單位，併發 ${opts.conc}`);
  let ok = 0, skip = 0, empty = 0, fail = 0;
  const start = Date.now();

  await runPool(units, opts.conc, async (unit) => {
    const outPath = path.join(outDir, `${unit}.json`);
    if (!opts.force && existsSync(outPath)) { skip++; return; }

    let params: Record<string, string>;
    if (cfg.mode === 'by-date') params = { start_date: unit, end_date: unit };
    else if (cfg.mode === 'by-month') {
      const [y, m] = unit.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      params = { start_date: `${unit}-01`, end_date: `${unit}-${String(lastDay).padStart(2, '0')}` };
    } else params = { data_id: unit, start_date: '2015-01-01' };

    const rows = await fmFetch(token, cfg.ds, params);
    if (rows === null) { fail++; return; }
    const kept = cfg.filter ? rows.filter((r: any) => r.stock_id && keepCode(String(r.stock_id), uni)) : rows;
    if (kept.length === 0) {
      // by-date 近 4 天內回空 = 可能 EOD 未上架 → 不寫死，留下次重抓（避免永久缺）。
      if (cfg.mode === 'by-date') {
        const ageDays = (Date.parse(today) - Date.parse(unit)) / 86400000;
        if (ageDays <= 4) { fail++; return; }
      }
      // by-date/by-month 舊日空 = 非交易日/該月無；per-stock 空 = 該股無此資料。寫空檔避免重抓。
      writeFileSync(outPath, JSON.stringify({ unit, dataset: cfg.ds, count: 0, rows: [] }));
      empty++;
      return;
    }
    writeFileSync(outPath, JSON.stringify({ unit, dataset: cfg.ds, fetchedAt: new Date().toISOString(), count: kept.length, rows: kept }));
    ok++;
    if ((ok + empty) % 100 === 0) {
      const el = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`    ${key}: ok=${ok} empty=${empty} skip=${skip} fail=${fail} | ${el}s`);
    }
  });

  const el = ((Date.now() - start) / 1000).toFixed(0);
  const sz = dirSize(outDir);
  console.log(`✓ ${key} 完成：ok=${ok} empty=${empty} skip=${skip} fail=${fail} | ${el}s | ${sz}`);
}

function dirSize(dir: string): string {
  let bytes = 0;
  try { for (const f of readdirSync(dir)) bytes += readFileSync(path.join(dir, f)).length; } catch { /* */ }
  return bytes > 1e9 ? (bytes / 1e9).toFixed(1) + 'GB' : (bytes / 1e6).toFixed(0) + 'MB';
}

async function main() {
  const opts = parseArgs();
  if (opts.list) {
    console.log('可用資料集 key：');
    for (const [k, v] of Object.entries(DATASETS)) console.log(`  ${k.padEnd(14)} ${v.label} [${v.mode}]`);
    console.log('\n（分點主力另用 scripts/finmind-fetch-broker-detail.ts，因只能單檔單日查）');
    return;
  }
  const token = loadToken();
  if (!token) { console.error('❌ 無 FINMIND_API_TOKEN'); process.exit(1); }
  const uni = loadUniverse();
  const keys = opts.keys.length ? opts.keys : Object.keys(DATASETS);
  console.log(`[finmind-datasets] 跑：${keys.join(', ')}｜from ${opts.from}｜宇宙 ${uni.size}`);

  for (const key of keys) await runDataset(key, token, uni, opts);
  console.log(`\n✅ 全部完成。輸出在 data/_finmind/{${keys.join(',')}}/`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
