#!/usr/bin/env node
/**
 * 持股批量匯入 CLI
 *
 * 用法：
 *   npx tsx scripts/import-holdings.ts <csv-path> [--dry-run] [--force-price]
 *
 * CSV 規格（lib/portfolio/holdingsImport.ts）：
 *   必填：symbol, name, shares, avgCost
 *   選填：entryDate, stopLoss, target1, target2, industry, notes
 *
 * 範例：
 *   $ cat my-holdings.csv
 *   symbol,name,shares,avgCost,entryDate,stopLoss,target1,notes
 *   3037.TW,欣興,30,856.5,2026-04-15,800,1050,AI PCB
 *   2330.TW,台積電,5,1100,2026-03-10,1020,,
 *
 *   $ npx tsx scripts/import-holdings.ts my-holdings.csv --dry-run
 *   ✓ 2330.TW 台積電  5 張 @ 1100   entryDate=2026-03-10 stopLoss=1020
 *   ✗ 3037.TW 欣興    entryPrice 856.5 vs K 線 970 差 -12% (ok)
 *   ...
 *
 * 旗標：
 *   --dry-run     只解析+驗證，不寫 holdings.json
 *   --force-price 略過 entryPrice 合理性檢查
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  parseImportCsv,
  applyDefaults,
  type ParsedImportRow,
} from '@/lib/portfolio/holdingsImport';
import { validateEntryPrice } from '@/lib/agents/portfolio/validateEntryPrice';
import { upsertHolding } from '@/lib/agents/portfolio/storage';

function todayCst(): string {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  return tw.toISOString().slice(0, 10);
}

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args[0];
  const dryRun = args.includes('--dry-run');
  const forcePrice = args.includes('--force-price');

  if (!csvPath) {
    console.error('用法：npx tsx scripts/import-holdings.ts <csv-path> [--dry-run] [--force-price]');
    process.exit(1);
  }

  const abs = path.isAbsolute(csvPath) ? csvPath : path.join(process.cwd(), csvPath);
  const text = await fs.readFile(abs, 'utf-8');
  const r = parseImportCsv(text);
  if (!r.ok) {
    console.error(`CSV 解析失敗：${r.reason}`);
    process.exit(1);
  }

  const today = todayCst();
  let inserted = 0, rejected = 0;
  const rejections: Array<{ row: number; symbol?: string; reason: string }> = [];

  for (const p of r.parsed) {
    if (!p.ok || !p.row) {
      rejected++;
      rejections.push({ row: p.rowNumber, symbol: p.raw.symbol, reason: p.reason ?? 'unknown' });
      console.log(`✗ row ${p.rowNumber} ${p.raw.symbol ?? '?'} ${p.reason}`);
      continue;
    }

    let holdingData;
    try { holdingData = applyDefaults(p.row, today); }
    catch (e) {
      rejected++;
      const msg = e instanceof Error ? e.message : String(e);
      rejections.push({ row: p.rowNumber, symbol: p.row.symbol, reason: msg });
      console.log(`✗ row ${p.rowNumber} ${p.row.symbol} ${msg}`);
      continue;
    }

    if (!forcePrice) {
      const check = await validateEntryPrice(
        holdingData.symbol, holdingData.market, holdingData.entryDate, holdingData.entryPrice,
      );
      if (!check.ok) {
        rejected++;
        rejections.push({ row: p.rowNumber, symbol: p.row.symbol, reason: check.reason ?? 'price invalid' });
        console.log(`✗ row ${p.rowNumber} ${p.row.symbol} ${check.reason}`);
        continue;
      }
    }

    if (dryRun) {
      console.log(`✓ [dry-run] row ${p.rowNumber} ${holdingData.symbol} ${holdingData.name} ${holdingData.shares} 張 @ ${holdingData.entryPrice} entryDate=${holdingData.entryDate} stopLoss=${holdingData.stopLoss}`);
    } else {
      try {
        await upsertHolding(holdingData);
        console.log(`✓ row ${p.rowNumber} ${holdingData.symbol} ${holdingData.name} ${holdingData.shares} 張 @ ${holdingData.entryPrice}`);
        inserted++;
      } catch (e) {
        rejected++;
        const msg = e instanceof Error ? e.message : String(e);
        rejections.push({ row: p.rowNumber, symbol: p.row.symbol, reason: msg });
        console.log(`✗ row ${p.rowNumber} ${p.row.symbol} ${msg}`);
      }
    }
  }

  console.log('');
  console.log(`==== 總結 ====`);
  console.log(`匯入 ${inserted} 筆 / 拒絕 ${rejected} 筆 / 共 ${r.parsed.length} 筆`);
  if (dryRun) console.log(`[dry-run] 未實際寫入 holdings.json`);
  if (rejections.length) {
    console.log('');
    console.log('拒絕詳情：');
    for (const x of rejections) {
      console.log(`  row ${x.row} ${x.symbol ?? '?'}：${x.reason}`);
    }
    process.exit(2);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
