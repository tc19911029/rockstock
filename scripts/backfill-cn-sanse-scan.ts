// ============================================================
// 回補三色資金歷史掃描：對最近 N 個陸股交易日，把各檔本地 K 線截到該日重算 scanSanSe，
// 固化每日 session → data/cn-sanse-scan/{date}.json，讓日期 chip 一上線就有歷史 + 漲跌幅。
//
// 用法：npx tsx scripts/backfill-cn-sanse-scan.ts [天數，預設 22]
//       npx tsx scripts/backfill-cn-sanse-scan.ts --existing
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { scanSanSe } from '@/lib/cn-sanse/scan';
import { saveSanSeScan } from '@/lib/cn-sanse/scanStorage';
import type { Candle } from '@/types';

const INDEX_SYMBOL = '000001.SS';

async function main() {
  const existingOnly = process.argv.includes('--existing');
  const daysArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const days = parseInt(daysArg ?? '22', 10) || 22;
  const dir = getLocalCandleDir('CN');
  const outputDir = path.join(process.cwd(), 'data/cn-sanse-scan');

  // 交易日清單 = 上證指數本地 K 的日期
  const raw = await fs.readFile(path.join(dir, `${INDEX_SYMBOL}.json`), 'utf8');
  const idx = JSON.parse(raw)?.candles as Candle[] | undefined;
  if (!Array.isArray(idx) || idx.length === 0) throw new Error(`找不到 ${INDEX_SYMBOL} 本地 K 線`);

  const tradingDays = existingOnly
    ? (await fs.readdir(outputDir))
      .map((name) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1])
      .filter((date): date is string => Boolean(date))
      .sort()
    : idx.map((c) => c.date).slice(-days);
  if (tradingDays.length === 0) throw new Error('沒有可回補的三色資金日期');
  if (existingOnly) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(process.cwd(), `data/cn-sanse-scan-backup-${stamp}`);
    await fs.mkdir(backupDir, { recursive: true });
    await Promise.all(tradingDays.map((date) => fs.copyFile(
      path.join(outputDir, `${date}.json`),
      path.join(backupDir, `${date}.json`),
    )));
    console.log(`[backfill] 已備份 ${tradingDays.length} 天 → ${path.relative(process.cwd(), backupDir)}`);
  }
  console.log(`[backfill] 回補最近 ${tradingDays.length} 個交易日：${tradingDays[0]} ~ ${tradingDays[tradingDays.length - 1]}`);

  for (const date of tradingDays) {
    const t0 = Date.now();
    try {
      const result = await scanSanSe({ asOfDate: date });
      await saveSanSeScan(result);
      const { strict, medium, loose } = result.counts;
      console.log(
        `[backfill] ${date} ✓ 評估 ${result.evaluated} 檔（剔除落後 ${result.staleSkipped}）` +
        ` 嚴 ${strict} / 中 ${medium} / 寬 ${loose}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
    } catch (e) {
      console.error(`[backfill] ${date} ✗ ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log('[backfill] 完成');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
