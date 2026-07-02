/**
 * 清理 CN 掃描 session 裡 000001.SZ（平安银行）被 000001.SS（上證指數）撞庫污染的殘留紀錄。
 *
 * 背景：2026-05 期間（修復 commit 59c21c7 之前），盤中即時報價把上證指數(000001.SS, ~4100)
 * 的值串進平安银行(000001.SZ, ~11)，使部分 scan session 落地了「平安银行 漲幅 +37000%、價 ~4100」
 * 的假紀錄（誤觸 O/Q 等買法）。L1 日K 本身乾淨、bug 已修，只需清掉 session 檔裡的歷史殘留。
 *
 * 判定污染：symbol=000001.SZ 且（price > 100 或 |changePercent| > 50）—— 平安银行真實價 ~11、
 * 上證指數 ~3400-4100，差兩個數量級，不會誤殺正常紀錄。
 *
 * 用法：
 *   npx tsx scripts/repair-cn-000001-scan-contamination.ts          # dry-run（只印不改）
 *   npx tsx scripts/repair-cn-000001-scan-contamination.ts --apply  # 實際清理
 */

import fs from 'fs';
import path from 'path';

const DATA = path.join(process.cwd(), 'data');
const APPLY = process.argv.includes('--apply');

interface ScanResult { symbol?: string; name?: string; price?: number; changePercent?: number }
interface ScanSession { date?: string; resultCount?: number; results?: ScanResult[] }

function isContaminated(r: ScanResult): boolean {
  if (!r.symbol || !r.symbol.startsWith('000001.SZ')) return false;
  return (r.price ?? 0) > 100 || Math.abs(r.changePercent ?? 0) > 50;
}

function main(): void {
  const files = fs.readdirSync(DATA).filter((f) => /^scan-CN-long-.*\.json$/.test(f));
  let changedFiles = 0;
  let removedRecords = 0;
  const sample: string[] = [];

  for (const f of files) {
    const fp = path.join(DATA, f);
    let session: ScanSession;
    try { session = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { continue; }
    const results = session.results ?? [];
    const dirty = results.filter(isContaminated);
    if (dirty.length === 0) continue;

    const cleaned = results.filter((r) => !isContaminated(r));
    session.results = cleaned;
    session.resultCount = cleaned.length;
    changedFiles++;
    removedRecords += dirty.length;
    if (sample.length < 8) {
      sample.push(`  ${f} | 移除 ${dirty.length} 筆（${dirty.map((d) => `${d.symbol} 漲幅${d.changePercent?.toFixed(0)}% 價${d.price}`).join('; ')}）→ resultCount ${results.length}→${cleaned.length}`);
    }
    if (APPLY) fs.writeFileSync(fp, JSON.stringify(session));
  }

  console.log(`\n  ${APPLY ? '【已清理】' : '【DRY-RUN，未改檔，加 --apply 才實際清】'}`);
  console.log(`  受污染檔: ${changedFiles}　移除紀錄: ${removedRecords}`);
  console.log(sample.join('\n'));
  if (!APPLY && changedFiles > 0) console.log('\n  → 確認無誤後執行：npx tsx scripts/repair-cn-000001-scan-contamination.ts --apply\n');
}

main();
