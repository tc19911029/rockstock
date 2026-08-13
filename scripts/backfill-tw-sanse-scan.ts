// ============================================================
// 台股三色資金 — L4 掃描結果回補（過去 N 個交易日）
//
// 逐日 scanTwSanSe({asOfDate}) → saveTwSanSeScan 固化到 data/tw-sanse-scan/{date}.json。
// 交易日來源 = ^TWII 本地 K 線日期（與 scanTwSanSe 內部一致）。
//
// 用法：npx tsx scripts/backfill-tw-sanse-scan.ts [天數=20]
//       npx tsx scripts/backfill-tw-sanse-scan.ts --existing
// ============================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanTwSanSe } from '@/lib/tw-sanse/scan';
import { saveTwSanSeScan } from '@/lib/tw-sanse/scanStorage';
import type { Candle } from '@/types';

(async () => {
  const existingOnly = process.argv.includes('--existing');
  const daysArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const days = parseInt(daysArg ?? '20', 10) || 20;
  const dir = path.join(process.cwd(), 'data/candles/TW');
  const idx = JSON.parse(await fs.readFile(path.join(dir, '^TWII.json'), 'utf8')).candles as Candle[];
  const outputDir = path.join(process.cwd(), 'data/tw-sanse-scan');
  const targets = existingOnly
    ? (await fs.readdir(outputDir))
      .map((name) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1])
      .filter((date): date is string => Boolean(date))
      .sort()
    : idx.map((c) => c.date).slice(-days);

  if (targets.length === 0) throw new Error('沒有可回補的三色資金日期');
  if (existingOnly) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(process.cwd(), `data/tw-sanse-scan-backup-${stamp}`);
    await fs.mkdir(backupDir, { recursive: true });
    await Promise.all(targets.map((date) => fs.copyFile(
      path.join(outputDir, `${date}.json`),
      path.join(backupDir, `${date}.json`),
    )));
    console.log(`[backfill-tw-sanse] 已備份 ${targets.length} 天 → ${path.relative(process.cwd(), backupDir)}`);
  }

  console.log(`[backfill-tw-sanse] 回補 ${targets.length} 交易日：${targets[0]} ~ ${targets.at(-1)}`);
  let ok = 0;
  let warn = 0;
  for (const date of targets) {
    const t0 = Date.now();
    try {
      const r = await scanTwSanSe({ asOfDate: date });
      if (r.lastDate !== date) {
        console.warn(`[backfill-tw-sanse] ${date} ⚠️ lastDate=${r.lastDate}≠asOf（指數無該日 bar，跳過存檔）`);
        warn++;
        continue;
      }
      await saveTwSanSeScan(r);
      ok++;
      console.log(`[backfill-tw-sanse] ${date} ✓ 掃 ${r.evaluated} / stale ${r.staleSkipped} / 嚴${r.counts.strict} 中${r.counts.medium} 寬${r.counts.loose} / 共振 ${r.records.length}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      console.error(`[backfill-tw-sanse] ${date} ✗ ${e instanceof Error ? e.message : e}`);
      warn++;
    }
  }
  console.log(`\n[backfill-tw-sanse] 完成：固化 ${ok} 天，異常/跳過 ${warn} 天 → data/tw-sanse-scan/`);
})().catch((e) => { console.error(e); process.exit(1); });
