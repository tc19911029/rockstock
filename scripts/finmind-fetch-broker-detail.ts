#!/usr/bin/env npx tsx
/**
 * finmind-fetch-broker-detail.ts — 抓「券商分點進出明細」(TaiwanStockTradingDailyReport)。
 *
 * 限制：FinMind 此資料集只能「單檔單日」查（data_id + 單一 start_date，不吃日期區間），
 * 一檔一天回約數千筆分點。全市場全歷史不切實際 → 只針對指定股票(預設=各 profile 持股)、近期窗口。
 * 用途：主力成本面板(chipcost) 累積。
 *
 * 用法：
 *   npx tsx scripts/finmind-fetch-broker-detail.ts                  # 持股 × 近 250 交易日
 *   npx tsx scripts/finmind-fetch-broker-detail.ts --days 120 --codes 2330,2303
 *   npx tsx scripts/finmind-fetch-broker-detail.ts --codes 2330 --days 60 --conc 4
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { globSync } from 'glob';

const REPO = process.cwd();
const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';
const PRICE_DIR = path.join(REPO, 'data', '_finmind', 'TW');
const OUT_ROOT = path.join(REPO, 'data', '_finmind', 'broker-detail');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function loadToken(): string {
  const p = path.join(REPO, '.env.local');
  for (const line of (existsSync(p) ? readFileSync(p, 'utf-8') : '').split('\n')) {
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
  return {
    days: get('--days') ? parseInt(get('--days')!, 10) : 250,
    codes: get('--codes')?.split(',').map((s) => s.trim()),
    conc: get('--conc') ? parseInt(get('--conc')!, 10) : 4,
    force: a.includes('--force'),
  };
}

// 各 profile 持股的台股代號
function holdingsCodes(): string[] {
  const codes = new Set<string>();
  const files = globSync('data/agents/portfolio/holdings*.json').concat(globSync('data/portfolios/*/holdings*.json'));
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(f, 'utf-8'));
      let rows: any[] = Array.isArray(d) ? d : d.holdings ?? [];
      if (!Array.isArray(rows) && typeof rows === 'object') rows = Object.values(rows);
      for (const h of rows) {
        if (!h || typeof h !== 'object') continue;
        const sym = String(h.symbol ?? h.code ?? '');
        if (!sym || sym.includes('.SS') || sym.includes('.SZ') || sym.includes('.OF')) continue;
        const code = sym.replace(/\.(TW|TWO)$/i, '');
        if (/^\d{4}/.test(code)) codes.add(code);
      }
    } catch { /* skip */ }
  }
  return [...codes].sort();
}

function tradingDays(days: number): string[] {
  const all: string[] = [];
  for (const f of readdirSync(PRICE_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      if (JSON.parse(readFileSync(path.join(PRICE_DIR, f), 'utf-8')).tradingDay) all.push(f.replace('.json', ''));
    } catch { /* */ }
  }
  return all.sort().slice(-days);
}

async function fmFetch(token: string, code: string, date: string): Promise<any[] | null> {
  const u = `${FINMIND_API}?dataset=TaiwanStockTradingDailyReport&data_id=${code}&start_date=${date}&end_date=${date}&token=${token}`;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(40000) });
      if (res.status === 402 || res.status === 429) { await sleep(45000); continue; }
      if (!res.ok) { await sleep(2500); continue; }
      const j = (await res.json()) as { status: number; data?: any[] };
      if (j.status !== 200) { await sleep(2500); continue; }
      return j.data ?? [];
    } catch { await sleep(2500); }
  }
  return null;
}

async function runPool<T>(items: T[], conc: number, worker: (x: T) => Promise<void>) {
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(conc, items.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        await worker(items[i]);
      }
    }),
  );
}

async function main() {
  const token = loadToken();
  if (!token) { console.error('❌ 無 FINMIND_API_TOKEN'); process.exit(1); }
  const opts = parseArgs();
  const codes = opts.codes ?? holdingsCodes();
  const days = tradingDays(opts.days);
  if (!codes.length) { console.log('沒有持股代號，結束。'); return; }
  if (!existsSync(OUT_ROOT)) mkdirSync(OUT_ROOT, { recursive: true });

  console.log(`[broker-detail] ${codes.length} 檔 × 近 ${days.length} 交易日 = ${codes.length * days.length} 請求｜併發 ${opts.conc}`);
  console.log(`  代號：${codes.join(', ')}`);

  let ok = 0, skip = 0, empty = 0, fail = 0;
  const start = Date.now();
  const tasks: Array<{ code: string; date: string }> = [];
  for (const code of codes) for (const date of days) tasks.push({ code, date });

  await runPool(tasks, opts.conc, async ({ code, date }) => {
    const dir = path.join(OUT_ROOT, code);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${date}.json`);
    if (!opts.force && existsSync(out)) { skip++; return; }
    const rows = await fmFetch(token, code, date);
    if (rows === null) { fail++; return; }
    writeFileSync(out, JSON.stringify({ code, date, count: rows.length, rows }));
    if (rows.length === 0) empty++; else ok++;
    if ((ok + empty + skip) % 200 === 0) {
      const el = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`  ok=${ok} empty=${empty} skip=${skip} fail=${fail} | ${el}s`);
    }
  });

  const el = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`\n✅ 完成：ok=${ok} empty=${empty} skip=${skip} fail=${fail} | ${el}s | 輸出 ${OUT_ROOT}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
