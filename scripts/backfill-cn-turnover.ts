/**
 * 兩市成交額歷史回填 — patch 既有 limitup-pool / breadth 檔（一次性，2026-06-13）
 *
 * 背景：cn-agents 全量回填時 push2his 處於批量封鎖期，歷史「兩市成交額」全 null
 * （turnoverShSzCny / totalTurnover / turnoverRatio5d）。本腳本改用交易所官方
 * 每日概况（scripts/cn_market_turnover.py，走 sse.com.cn / szse.cn）補回。
 *
 * 流程（不重算情緒階段 — turnover 不進 cycle.ts 判定）：
 *   1. 列出所有 limitup-pool 日檔；spawn python 取 {date → 兩市成交額(元)}
 *   2. 升冪逐日 patch pool.breadth.turnoverShSzCny → 存 pool
 *   3. 用 buildMarketBreadthDay(patched pool, 已 patch 的 turnoverHistory) 重建
 *      MarketBreadthDay（totalTurnover + turnoverRatio5d 精確重算），
 *      載入既有 breadth 檔、只換 .breadth、保留 .cycle/.cycleRulesVersion → 存
 *   4. 重建 breadth/index.json（最後 120 日）
 *
 * 用法：npx tsx scripts/backfill-cn-turnover.ts [--dry-run]
 */

import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { buildMarketBreadthDay } from '@/lib/cn-agents/breadth';
import { BREADTH_INDEX_MAX_DAYS, CN_AGENTS_SCHEMA_VERSION } from '@/lib/cn-agents/types';
import type { LimitUpPoolDay, BreadthDayFile, BreadthIndexFile } from '@/lib/cn-agents/types';

const ROOT = path.join(process.cwd(), 'data', 'cn-agents');
const POOL_DIR = path.join(ROOT, 'limitup-pool');
const BREADTH_DIR = path.join(ROOT, 'breadth');
const INDEX_PATH = path.join(BREADTH_DIR, 'index.json');
const PY_SCRIPT = path.join(process.cwd(), 'scripts', 'cn_market_turnover.py');
const PY_BATCH = 60; // 每批日期數（單一 python 程序內順序抓，避免 spawn 過多）

const dryRun = process.argv.includes('--dry-run');

async function listDates(dir: string): Promise<string[]> {
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  return files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
}

function fetchTurnoverBatch(dates: string[]): Promise<Record<string, number>> {
  const extraPaths = [`${homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  const augmentedPath = [...extraPaths, process.env.PATH || ''].filter(Boolean).join(':');
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('python3', [PY_SCRIPT, dates.join(',')], {
      env: { ...process.env, PATH: augmentedPath },
    });
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (c: string) => { stdout += c; });
    child.on('error', () => resolve({}));
    child.on('close', () => {
      try {
        const j = JSON.parse(stdout.trim()) as { ok?: boolean; data?: Record<string, number> };
        resolve(j?.ok && j.data ? j.data : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function main(): Promise<void> {
  const poolDates = await listDates(POOL_DIR);
  console.log(`📂 limitup-pool 日檔 ${poolDates.length} 個（${poolDates[0]} ~ ${poolDates[poolDates.length - 1]}）`);

  // 1) 取成交額 map（分批 spawn python）
  const turnover: Record<string, number> = {};
  for (let i = 0; i < poolDates.length; i += PY_BATCH) {
    const batch = poolDates.slice(i, i + PY_BATCH);
    const m = await fetchTurnoverBatch(batch);
    Object.assign(turnover, m);
    console.log(`  成交額抓取 ${Math.min(i + PY_BATCH, poolDates.length)}/${poolDates.length}（累計命中 ${Object.keys(turnover).length}）`);
  }
  const hit = Object.keys(turnover).length;
  console.log(`💰 成交額命中 ${hit}/${poolDates.length} 日`);
  if (hit === 0) {
    console.error('❌ 一日都沒抓到（akshare 未裝或交易所源異常）— 中止，不動任何檔');
    process.exit(1);
  }

  if (dryRun) {
    const sample = poolDates.filter((d) => turnover[d]).slice(-3);
    for (const d of sample) console.log(`  [dry] ${d} → ${(turnover[d] / 1e12).toFixed(3)} 兆`);
    console.log('🟡 --dry-run：未寫任何檔');
    return;
  }

  // 2) patch pool.breadth.turnoverShSzCny
  let poolPatched = 0;
  for (const d of poolDates) {
    const t = turnover[d];
    if (t == null) continue;
    const p = path.join(POOL_DIR, `${d}.json`);
    const pool = JSON.parse(await fs.readFile(p, 'utf-8')) as LimitUpPoolDay;
    if (pool.breadth.turnoverShSzCny === t) continue;
    pool.breadth.turnoverShSzCny = t;
    await atomicFsPut(p, JSON.stringify(pool));
    poolPatched++;
  }
  console.log(`✅ limitup-pool patched ${poolPatched} 日`);

  // 3) 重建 breadth.breadth（保留 cycle）— 升冪，turnoverHistory 用已 patch 的 pool
  const breadthDates = await listDates(BREADTH_DIR);
  const turnoverHistory: Array<{ date: string; turnover: number | null }> = [];
  let breadthPatched = 0;
  const indexEntries: BreadthIndexFile['days'] = [];

  for (const d of breadthDates) {
    const poolPath = path.join(POOL_DIR, `${d}.json`);
    const breadthPath = path.join(BREADTH_DIR, `${d}.json`);
    let pool: LimitUpPoolDay;
    let bf: BreadthDayFile;
    try {
      pool = JSON.parse(await fs.readFile(poolPath, 'utf-8')) as LimitUpPoolDay;
      bf = JSON.parse(await fs.readFile(breadthPath, 'utf-8')) as BreadthDayFile;
    } catch {
      continue; // pool 或 breadth 缺 → 跳過（保留歷史現狀）
    }
    const rebuilt = buildMarketBreadthDay({ pool, turnoverHistory });
    // 只換 breadth，保留 cycle / generatedAt / cycleRulesVersion（不重算階段）
    if (JSON.stringify(bf.breadth) !== JSON.stringify(rebuilt)) {
      bf.breadth = rebuilt;
      await atomicFsPut(breadthPath, JSON.stringify(bf));
      breadthPatched++;
    }
    turnoverHistory.push({ date: d, turnover: pool.breadth.turnoverShSzCny });
    indexEntries.push({ date: d, breadth: bf.breadth, cycle: bf.cycle });
  }
  console.log(`✅ breadth patched ${breadthPatched} 日`);

  // 4) 重建 index.json（最後 120 日）
  const index: BreadthIndexFile = {
    schemaVersion: CN_AGENTS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    days: indexEntries.slice(-BREADTH_INDEX_MAX_DAYS),
  };
  await atomicFsPut(INDEX_PATH, JSON.stringify(index));
  console.log(`✅ index.json 重建：收最後 ${index.days.length} 日`);
  console.log('🎉 完成');
}

main().catch((err) => {
  console.error('回填中斷：', err);
  process.exit(1);
});
