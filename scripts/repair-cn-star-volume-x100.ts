#!/usr/bin/env npx tsx
// ============================================================
// 科創板(688/689) L1 volume ×100 污染修復 — 騰訊整段重抓覆蓋（只覆蓋 volume，保留 OHLC）
//
// 病徵（2026-07-03）：騰訊 fqkline 對科創板回「股」，被 TencentHistProvider 當主板的「手」
//   統一 ×100 → 379 檔科創股 volume 灌成真實 100 倍。且非整段一致：62 檔在 2024-07-01 有
//   接縫（前段=backfill f6 校準正確、後段=某次 2y catchup ×100 覆寫）、~200 檔歷史 ×100 但
//   今日 bar 正確（EM 快照 append f5×100 沒病）→ 盲 ÷100 會砍壞正確段，必須逐日對源重建。
//
// 修法：TencentHistProvider 已修（sh688/sh689 不再 ×100）→ 用它整段重抓 5y，按日期只覆蓋
//   「顯著不符」(>1.5×) 的 volume。與 repair-cn-volume-from-tencent.ts 同款（先例），
//   但目標鎖定全部 68[89]* 檔（不靠內部量階篩，×100 整段一致的檔測不出量階）。
//
//   npx tsx scripts/repair-cn-star-volume-x100.ts 688981.SS          # 單檔 dry-run
//   npx tsx scripts/repair-cn-star-volume-x100.ts --apply            # 全部 379 檔修復
// ============================================================
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
if (existsSync('.env.local')) dotenv.config({ path: '.env.local' });
import { tencentHistProvider } from '@/lib/datasource/TencentHistProvider';
import type { Candle } from '@/types';

const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.find((a) => /^\d{6}\.(SS|SZ)$/.test(a));
const DELAY_MS = 400;
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

(async () => {
  const dir = path.join(process.cwd(), 'data/candles/CN');
  let files = (await fs.readdir(dir)).filter((f) => /^68[89]\d{3}\.SS\.json$/.test(f));
  if (ONLY) files = files.filter((f) => f === `${ONLY}.json`);
  console.log(`目標(科創板全檔): ${files.length} 檔  ${APPLY ? '【--apply 覆蓋】' : '(dry-run)'}`);

  const backupDir = path.join(process.cwd(), 'data/candles', `CN-backup-star-volume-${STAMP}`);
  let ok = 0, noTx = 0, fail = 0, unchanged = 0, totalChanged = 0;
  const failed: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const sym = f.replace('.json', '');
    let local: { candles: Candle[]; [k: string]: unknown };
    try { local = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')); } catch { fail++; failed.push(`${sym}(read)`); continue; }
    if (!Array.isArray(local.candles) || local.candles.length === 0) { unchanged++; continue; }

    let tx: Candle[] = [];
    try { tx = await tencentHistProvider.getHistoricalCandles(sym, '5y'); } // provider 已修：科創回「股」不再 ×100
    catch (e) { fail++; failed.push(`${sym}(${(e as Error).message.slice(0, 30)})`); await sleep(DELAY_MS); continue; }
    if (!tx.length) { noTx++; failed.push(`${sym}(騰訊無資料)`); await sleep(DELAY_MS); continue; }
    const tvol = new Map(tx.map((c) => [c.date, c.volume]));

    let changed = 0;
    const samples: string[] = [];
    for (const c of local.candles) {
      const v = tvol.get(c.date);
      // 只覆蓋「顯著不符」(>1.5×)：精準打 ×100 段，略過正確段的自然噪聲
      if (v != null && v > 0 && (c.volume <= 0 || v / c.volume > 1.5 || c.volume / v > 1.5)) {
        if (samples.length < 2) samples.push(`${c.date}:${c.volume}→${v}`);
        changed++;
        if (APPLY) c.volume = v;
      }
    }
    totalChanged += changed;
    if (changed === 0) { unchanged++; }
    if (ONLY || i < 5 || (changed > 0 && ok < 5)) console.log(`  ${sym.padEnd(11)} 覆蓋 ${changed}/${local.candles.length} 根  ${samples.join('  ')}`);

    if (APPLY && changed > 0) {
      await fs.mkdir(backupDir, { recursive: true });
      const bkp = path.join(backupDir, f);
      try { await fs.access(bkp); } catch { await fs.copyFile(path.join(dir, f), bkp); }
      await fs.writeFile(path.join(dir, f), JSON.stringify(local));
      try { const { invalidateEntry } = await import('@/lib/datasource/L1CandleCache'); invalidateEntry(sym, 'CN'); }
      catch { /* 清不到不致命 */ }
      ok++;
    }
    await sleep(DELAY_MS);
    if ((i + 1) % 50 === 0) console.log(`  …進度 ${i + 1}/${files.length}  覆蓋檔=${ok} 無需改=${unchanged} 騰訊無資料=${noTx} 失敗=${fail}`);
  }

  console.log(`\n完成：覆蓋 ${ok} 檔 / 共改 ${totalChanged} 根；無需改 ${unchanged}；騰訊無資料 ${noTx}；失敗 ${fail}`);
  if (failed.length) console.log(`待處理清單：${failed.join(', ')}`);
  if (APPLY && ok > 0) console.log(`備份在 ${backupDir}`);
})();
