/**
 * 刪除 CN L1 裡 OHLC 含非正值的 K 棒（2026-07-23）。
 *
 * 成因：Tencent qfq（前復權）對「累計配息/配股超過當時股價」的老股會算出負數
 *（000937.SZ 2021-07-09 open=-0.04、600066.SS 2022-04-27 low=-0.1）。
 * 這是還原公式本身在極端情況下的數學產物，不是抓取錯誤 —— 但負價的 K 棒無法使用
 *（型態、報酬、對數全部炸掉），且真值不可知 → 整根刪掉，不編造替代值。
 *
 * 同一批老股在那個年代還有 400 根 close<0.5 的 bar，那些數學上自洽（只是還原後很小），
 * 保留不動 —— 刪了會在序列中間打洞，而且回測視窗（近 2 年）根本用不到。
 *
 * 用法：npx tsx scripts/repair-cn-nonpositive-bars.ts [--apply]
 */
import fs from 'fs';
import path from 'path';

const APPLY = process.argv.includes('--apply');
const DIR = path.join(process.cwd(), 'data/candles/CN');
interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

let removed = 0, touchedFiles = 0;
for (const f of fs.readdirSync(DIR)) {
  if (!/\.(SS|SZ)\.json$/.test(f)) continue;
  let d: { candles?: Bar[] };
  try { d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(d.candles)) continue;
  const before = d.candles.length;
  const kept = d.candles.filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0);
  if (kept.length === before) continue;
  for (const b of d.candles.filter((x) => !(x.open > 0 && x.high > 0 && x.low > 0 && x.close > 0))) {
    console.log(`  刪 ${f.replace('.json', '')} ${b.date}  O=${b.open} H=${b.high} L=${b.low} C=${b.close}`);
  }
  removed += before - kept.length; touchedFiles++;
  d.candles = kept;
  if (APPLY) fs.writeFileSync(path.join(DIR, f), JSON.stringify(d, null, 2));
}
console.log(`刪除 ${removed} 根 / ${touchedFiles} 檔${APPLY ? '（已寫入）' : ' [dry-run]'}`);
