/**
 * 30分K 暖機回補 — 為「六條件(30分K)」掃描墊底歷史(算 MA60 要 ≥60 根)。
 *
 * 挑 book universe(成交額前 TOP_N 台股) → 逐檔 Fugle 抓 3 個月 30分K(準確) → 寫進 30分K宇宙。
 * 一次性跑；之後由盤後刷新 route(refresh-30m-eod)每日維持準確。
 *
 * 跑法： npx tsx scripts/backfill-30m-warmup.ts [--top 500]
 *
 * ⚠️ Fugle 限流 ~48/分，500 檔 ~10-15 分；抓不到的會列在 coverage(不靜默截斷)。
 */
import { config } from 'dotenv';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });

import { getFugleHistoricalMinuteCandles } from '../lib/datasource/FugleProvider';
import { upsert30mUniverse, normalizeFugle30mToEndGrid } from '../lib/candles30m/Candle30mStore';
import type { Candle } from '../types/index';

const TW_DIR = path.join(process.cwd(), 'data/candles/TW');
const argTop = process.argv.indexOf('--top');
const TOP_N = argTop >= 0 ? parseInt(process.argv[argTop + 1], 10) || 500 : 500;
const CONCURRENCY = 6;

function todayTaipei(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }

async function rankUniverse(): Promise<string[]> {
  const files = (await fs.readdir(TW_DIR)).filter(f => f.endsWith('.TW.json') && !f.startsWith('^'));
  const ranked: { sym: string; med: number }[] = [];
  for (const f of files) {
    const j = await readJ(path.join(TW_DIR, f)); const cs: Candle[] = j?.candles ?? j;
    if (!Array.isArray(cs) || cs.length < 60) continue;
    const t = cs.slice(-60).map(c => c.close * (c.volume || 0)).filter(x => x > 0).sort((a, b) => a - b);
    if (!t.length) continue;
    ranked.push({ sym: f.replace('.TW.json', ''), med: t[Math.floor(t.length / 2)] });
  }
  ranked.sort((a, b) => b.med - a.med);
  return ranked.slice(0, TOP_N).map(r => r.sym);
}

async function fetch30m(sym: string): Promise<Candle[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cs = await getFugleHistoricalMinuteCandles(sym, '30m', '3mo'); // Fugle 要裸碼
    if (cs.length) return normalizeFugle30mToEndGrid(cs); // 降序→升序 + 結束時間9根/日網格 + 併收盤競價
    if (attempt === 0) await new Promise(r => setTimeout(r, 1500)); // 退避重試
  }
  return [];
}

async function main() {
  const date = todayTaipei();
  const syms = await rankUniverse();
  console.log(`挑成交額前 ${syms.length} 大台股，逐檔抓 3 個月 30分K…\n`);

  const bars: Record<string, Candle[]> = {};
  let ok = 0, empty = 0, tooFew = 0;
  const emptyList: string[] = [];
  // 限並發
  for (let i = 0; i < syms.length; i += CONCURRENCY) {
    const batch = syms.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async sym => ({ sym, cs: await fetch30m(sym) })));
    for (const { sym, cs } of results) {
      if (!cs.length) { empty++; emptyList.push(sym); continue; }
      if (cs.length < 60) { tooFew++; }
      bars[`${sym}.TW`] = cs; // 宇宙 key 帶 .TW 後綴(對齊掃描端 symbol)
      ok++;
    }
    if ((i + CONCURRENCY) % 60 < CONCURRENCY) console.log(`  進度 ${Math.min(i + CONCURRENCY, syms.length)}/${syms.length}…`);
  }

  await upsert30mUniverse(date, bars);
  console.log(`\n✅ 寫入 30分K宇宙(${date})`);
  console.log(`   抓到 ${ok} / 空 ${empty} / 根數<60 ${tooFew}(暖機不足) / 共 ${syms.length}`);
  console.log(`   coverage ${(ok / syms.length * 100).toFixed(0)}%`);
  if (empty) console.log(`   抓空(前20): ${emptyList.slice(0, 20).join(', ')}`);
}
main();
