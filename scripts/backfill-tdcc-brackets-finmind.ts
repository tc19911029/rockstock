/**
 * 回補 TDCC 集保戶股權分散「全 15 級距歷史」— 走 FinMind TaiwanStockHoldingSharesPer。
 *
 * 為什麼 FinMind 行而 twsthr 不行：FinMind 這個 dataset = 集保官方股權分散表全 15 級距
 * （每格人數+比例），且有逐週歷史（2330 可回到 2015）。twsthr 歷史只有 >400張 大戶幾格。
 *
 * 做法：每檔打一次 FinMind（data_id=code，full history），把每週的 brackets 合併進
 * `data/chips/TW/tdcc/{code}.json`：
 *   - 既有週 → 只「加 brackets」，不動既有聚合 holder*Pct（守歷史封存不可變）
 *   - 沒有的舊週 → 整筆補（brackets + 從同源 percent 算出的聚合）
 *
 * 數字與 TDCC 同源（FinMind 轉自 TDCC），聚合算法與 parseTdccCsv 完全一致。
 *
 * 用法：
 *   npx tsx scripts/backfill-tdcc-brackets-finmind.ts --symbols 2330,1216 [--dry-run]
 *   npx tsx scripts/backfill-tdcc-brackets-finmind.ts --from 2022-01-01   # 全市場（讀 tdcc 目錄）
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { readTdccStock } from '@/lib/chips/ChipStorage';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import type { TdccDay } from '@/lib/chips/types';

const TOKEN = (process.env.FINMIND_API_TOKEN || '').trim();
const TDCC_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'tdcc');

/** FinMind HoldingSharesLevel 字串 → 持股分級 1-15（total/差異數不在表內） */
const LEVEL_MAP: Record<string, number> = {
  '1-999': 1, '1,000-5,000': 2, '5,001-10,000': 3, '10,001-15,000': 4, '15,001-20,000': 5,
  '20,001-30,000': 6, '30,001-40,000': 7, '40,001-50,000': 8, '50,001-100,000': 9, '100,001-200,000': 10,
  '200,001-400,000': 11, '400,001-600,000': 12, '600,001-800,000': 13, '800,001-1,000,000': 14,
  'more than 1,000,001': 15,
};

interface FmRow { date: string; HoldingSharesLevel: string; people: number; percent: number }

async function fetchHistory(code: string, from: string): Promise<FmRow[]> {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockHoldingSharesPer&data_id=${code}&start_date=${from}&token=${TOKEN}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (res.status === 402) throw new Error('FinMind 402 額度用罄');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 200) throw new Error(j.msg || 'finmind error');
  return (j.data ?? []) as FmRow[];
}

/** 把 FinMind rows 按週組成 { date → TdccDay }（brackets + 聚合，同 parseTdccCsv 算法） */
function buildWeeks(rows: FmRow[]): Array<{ date: string; day: TdccDay }> {
  const byDate = new Map<string, { brackets: { level: number; holders: number; pct: number }[]; total: number | null }>();
  for (const r of rows) {
    const lvl = LEVEL_MAP[r.HoldingSharesLevel];
    const isTotal = r.HoldingSharesLevel === 'total';
    if (lvl == null && !isTotal) continue; // 差異數調整 跳過
    let cur = byDate.get(r.date);
    if (!cur) { cur = { brackets: [], total: null }; byDate.set(r.date, cur); }
    if (isTotal) cur.total = r.people;
    else cur.brackets.push({ level: lvl, holders: r.people, pct: +Number(r.percent).toFixed(2) });
  }
  const out: Array<{ date: string; day: TdccDay }> = [];
  for (const [date, v] of byDate) {
    if (!v.brackets.length) continue;
    const byLevel = new Map(v.brackets.map(b => [b.level, b.pct]));
    const p = (lv: number) => byLevel.get(lv) ?? 0;
    const p10 = p(10), p11 = p(11), p12 = p(12), p13 = p(13), p14 = p(14), p15 = p(15);
    const brackets = v.brackets.slice().sort((a, b) => a.level - b.level);
    out.push({
      date,
      day: {
        holder100Pct: +(p10 + p11 + p12 + p13 + p14 + p15).toFixed(2),
        holder200Pct: +(p11 + p12 + p13 + p14 + p15).toFixed(2),
        holder400Pct: +(p12 + p13 + p14 + p15).toFixed(2),
        holder1000Pct: +p15.toFixed(2),
        holder400To600Pct: +p12.toFixed(2),
        holder600To800Pct: +p13.toFixed(2),
        holder800To1000Pct: +p14.toFixed(2),
        holderCount: v.total ?? undefined,
        brackets,
      },
    });
  }
  return out;
}

async function backfillOne(code: string, from: string, dryRun: boolean) {
  const rows = await fetchHistory(code, from);
  if (!rows.length) return { code, weeks: 0, added: 0, enriched: 0, note: 'no-data' };
  const weeks = buildWeeks(rows);
  const existing = await readTdccStock(code);
  const map = new Map<string, { date: string } & TdccDay>();
  for (const r of existing?.data ?? []) map.set(r.date, r);
  let added = 0, enriched = 0;
  for (const { date, day } of weeks) {
    const ex = map.get(date);
    if (ex) {
      if (!ex.brackets?.length) { map.set(date, { ...ex, brackets: day.brackets }); enriched++; } // 只加 brackets
    } else {
      map.set(date, { date, ...day }); added++; // 補整週
    }
  }
  if (!dryRun && (added || enriched)) {
    const merged = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
    const file = { symbol: code, market: 'TW' as const, lastDate: merged[merged.length - 1]?.date ?? '', updatedAt: new Date().toISOString(), data: merged };
    await atomicFsPut(path.join(TDCC_DIR, `${code}.json`), JSON.stringify(file));
  }
  return { code, weeks: weeks.length, added, enriched };
}

async function listUniverse(): Promise<string[]> {
  const files = await fs.readdir(TDCC_DIR);
  return files.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).filter(c => /^\d{4,6}$/.test(c));
}

async function main() {
  if (!TOKEN) { console.error('❌ 缺 FINMIND_API_TOKEN'); process.exit(1); }
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const from = (args.find(a => a.startsWith('--from='))?.split('=')[1])
    ?? (args.includes('--from') ? args[args.indexOf('--from') + 1] : '2022-01-01');
  const symArg = args.find(a => a.startsWith('--symbols='))?.split('=')[1]
    ?? (args.includes('--symbols') ? args[args.indexOf('--symbols') + 1] : null);

  let universe: string[];
  if (symArg) universe = symArg.split(',').map(s => s.trim().replace(/\.(TW|TWO)$/i, '')).filter(Boolean);
  else universe = await listUniverse();

  console.log(`📥 FinMind 回補 TDCC 全級距歷史 from=${from} 共 ${universe.length} 檔${dryRun ? '（dry-run）' : ''}`);

  const CONC = 6; // 並發（會員 2萬/hr，6 並發 ~4 req/s，留餘裕）
  let done = 0, totalAdded = 0, totalEnriched = 0, fail = 0;
  for (let i = 0; i < universe.length; i += CONC) {
    const batch = universe.slice(i, i + CONC);
    const results = await Promise.allSettled(batch.map(c => backfillOne(c, from, dryRun)));
    for (const r of results) {
      done++;
      if (r.status === 'fulfilled') { totalAdded += r.value.added; totalEnriched += r.value.enriched; }
      else { fail++; if (fail <= 10) console.warn('  ⚠️', r.reason?.message ?? r.reason); }
    }
    if (done % 120 === 0 || done === universe.length) {
      console.log(`  ...${done}/${universe.length} added週=${totalAdded} enriched週=${totalEnriched} fail=${fail}`);
    }
  }
  console.log(`\n🎉 完成 done=${done} 補新週=${totalAdded} 既有週加brackets=${totalEnriched} fail=${fail}`);
}

main().catch(err => { console.error('❌', err); process.exit(1); });
