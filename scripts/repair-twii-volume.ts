/**
 * 修 ^TWII（台灣加權指數）L1 成交量 — Yahoo 殘缺量 → TWSE 官方成交股數。
 *
 * 病灶（2026-07-23 發現）：
 *   ^TWII 的 volume 一直是 Yahoo chart API 給的，實測只有官方成交股數的 35~57%，
 *   而且比例逐日浮動 —— 2026-07-17 崩盤日官方 182.4 億股（當月最大量），Yahoo 只給
 *   638 萬張，在序列裡排中段。「爆量」「量縮」判讀整段失真。
 *   同時 2026-07-22 起 append-from-snapshot 改吃 mis.twse t00 的 m（正確張數），
 *   序列在該日出現 4.7M → 11.2M 的假跳階。
 *
 * 修法：整段 volume 換成官方 FMTQIK 成交股數 ÷ 1000（張），OHLC 一律不動。
 *
 * 用法：
 *   npx tsx scripts/repair-twii-volume.ts --dry-run
 *   npx tsx scripts/repair-twii-volume.ts
 */

import fs from 'fs/promises';
import path from 'path';
import { fetchTwseMarketStatsMonth } from '../lib/datasource/TwseMarketStats';

const FILE = path.join(process.cwd(), 'data/candles/TW/^TWII.json');
const DRY = process.argv.includes('--dry-run');

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

async function main() {
  const raw = JSON.parse(await fs.readFile(FILE, 'utf8'));
  const candles: Bar[] = raw.candles ?? raw;
  console.log(`[repair-twii-volume] 讀到 ${candles.length} 根，${candles[0].date} ~ ${candles[candles.length - 1].date}`);

  const months = [...new Set(candles.map((c) => c.date.slice(0, 4) + c.date.slice(5, 7)))].sort();
  const official = new Map<string, number>();
  for (const m of months) {
    const stats = await fetchTwseMarketStatsMonth(m);
    for (const [date, s] of stats) official.set(date, s.volume);
    console.log(`  ${m}: 官方 ${stats.size} 個交易日`);
    await new Promise((r) => setTimeout(r, 300)); // 對官方站客氣一點
  }

  let changed = 0, missing = 0;
  let sumOld = 0, sumNew = 0;
  const samples: string[] = [];
  for (const c of candles) {
    const v = official.get(c.date);
    if (!v || v <= 0) { missing++; continue; }
    if (c.volume !== v) {
      if (samples.length < 10) samples.push(`  ${c.date}  ${c.volume.toLocaleString()} → ${v.toLocaleString()}  (×${(v / (c.volume || 1)).toFixed(2)})`);
      sumOld += c.volume; sumNew += v;
      c.volume = v;
      changed++;
    }
  }

  console.log(`\n改動 ${changed} 根 / 官方查無 ${missing} 根（多半是指數有 bar 但當日官方無統計）`);
  if (samples.length) console.log('樣本：\n' + samples.join('\n'));
  if (changed > 0) console.log(`\n舊均量 ${Math.round(sumOld / changed).toLocaleString()} → 新均量 ${Math.round(sumNew / changed).toLocaleString()} 張`);

  if (DRY) { console.log('\n[dry-run] 未寫檔'); return; }
  if (changed === 0) { console.log('無需修正'); return; }

  const backup = FILE.replace('.json', `.bak-volfix-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.copyFile(FILE, backup);
  if (raw.candles) raw.candles = candles; else { /* bare array */ }
  await fs.writeFile(FILE, JSON.stringify(raw.candles ? raw : candles, null, 2));
  console.log(`\n已寫入 ${FILE}（備份 ${path.basename(backup)}）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
