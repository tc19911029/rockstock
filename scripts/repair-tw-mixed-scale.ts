/**
 * 修「同一檔 L1 裡原始價與還原價交錯」（2026-07-23）。
 *
 * 病灶：舊版 Yahoo path 用 adjclose/close ratio 回頭改 OHLC（2026-05-21 已棄用，見
 * YahooDataProvider 的 @deprecated 註解），殘留把「還原價」一根一根插進原本是原始價的序列。
 * 7772.TWO 最誇張：~200（還原）與 ~85（原始）逐日交錯，任何 MA/型態/報酬全錯。
 *
 * 偵測：audit-l1-isolated-spike 找得到的「孤立尖刺」股（尖刺日 volume>0，排除無成交假 K）。
 * 修法：用現行 provider 鏈（FinMind→Fugle→TWSE→Yahoo raw，全是原始價）重抓，
 * **與舊檔合併**而不是整段取代 —— 重抓通常只回 5y，直接取代會砍掉更早的歷史（鐵則 #1）。
 * 合併規則（以日期做聯集，不是按位置切）：
 *   - 重抓有的日期 → 一律以重抓為準（原始價）
 *   - 重抓沒有的日期 → 舊 bar 本身是原始價就留著（provider 的 5y 本來就會漏日，
 *     直接丟會在序列中間打洞）；是還原價殘值才丟掉。
 *   - 最後再跑一次「物理不可能」過濾：台股漲跌停 ±10%，所以「單日偏離前後鄰居 >15%、
 *     而前後鄰居彼此相差 <12%」的 bar 一定是尺度殘值（真實市場做不出這種一日往返）。
 *     這類殘值小數位數正常（68.18），靠小數位判不出來，只能靠這條物理限制。
 *     判定為殘值就整根刪掉 —— 真值不可知，寧可留空也不要編一個價格。
 * 安全：覆寫前備份；重抓結果若仍含非原始價（>2 位小數）或根數過少 → 整檔放棄不動。
 *
 * 用法：npx tsx scripts/repair-tw-mixed-scale.ts [--apply] [--symbols 7772.TWO,2740.TWO]
 */
import { config } from 'dotenv';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import path from 'path';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { dataProvider } from '../lib/datasource/MultiMarketProvider';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { invalidateEntry } from '../lib/datasource/L1CandleCache';

const APPLY = process.argv.includes('--apply');
const symIdx = process.argv.indexOf('--symbols');
const symArg = symIdx >= 0 ? process.argv[symIdx + 1] : undefined;
const DIR = path.join(process.cwd(), 'data/candles/TW');
const nonRaw = (v: number) => Math.abs(v - Math.round(v * 100) / 100) > 0.002;

async function main() {
  let symbols: string[];
  if (symArg && !symArg.startsWith('--')) symbols = symArg.split(',');
  else {
    // 從最新一份 isolated-spike 報告取受害股
    const rptDir = path.join(process.cwd(), 'data/reports');
    const { readdirSync } = await import('fs');
    const f = readdirSync(rptDir).filter((x) => x.startsWith('audit-r21-isolated-spike')).sort().pop();
    if (!f) { console.error('找不到 audit-r21-isolated-spike 報告，先跑 audit-l1-isolated-spike.ts'); process.exit(1); }
    const rpt = JSON.parse(readFileSync(path.join(rptDir, f), 'utf8')) as { spikes?: Array<{ symbol: string }> } | Array<{ symbol: string }>;
    const rows = Array.isArray(rpt) ? rpt : (rpt.spikes ?? []);
    symbols = [...new Set(rows.map((r) => r.symbol))];
    console.log(`從 ${f} 取得 ${symbols.length} 檔受害股`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(process.cwd(), 'data/candles', `TW-backup-mixedscale-${stamp}`);
  if (APPLY) mkdirSync(backupDir, { recursive: true });

  let ok = 0, skip = 0;
  for (const sym of symbols) {
    const file = path.join(DIR, `${sym}.json`);
    if (!existsSync(file)) { skip++; continue; }
    const before = JSON.parse(readFileSync(file, 'utf8')).candles as Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    const beforeBad = before.filter((b) => nonRaw(b.close)).length;
    let fresh;
    try { fresh = await dataProvider.getHistoricalCandles(sym, '5y'); }
    catch (e) { console.warn(`  ✗ ${sym} 重抓失敗: ${(e as Error).message}`); skip++; continue; }
    const freshBad = fresh.filter((c) => nonRaw(c.close)).length;
    if (fresh.length < 60 || freshBad > 0) {
      console.warn(`  ✗ ${sym} 重抓結果不合格（${fresh.length} 根、非原始價 ${freshBad}）→ 保留原檔`);
      skip++; continue;
    }
    // 以日期做聯集合併
    const byDate = new Map<string, { date: string; open: number; high: number; low: number; close: number; volume: number }>();
    let keptOld = 0, dropped = 0;
    for (const b of before) {
      if (nonRaw(b.close) || nonRaw(b.open) || nonRaw(b.high) || nonRaw(b.low)) { dropped++; continue; }
      byDate.set(b.date, b); keptOld++;
    }
    for (const c of fresh) byDate.set(c.date, { date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    let merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    // 物理不可能過濾（台股 ±10% 漲跌停）
    // 不豁免重抓來的 bar —— provider 自己也會回這種殘值（8291.TWO 2023 年多筆 22 ↔ 6 往返）。
    // 物理限制與資料來源無關。
    let impossible = 0;
    merged = merged.filter((b, i, arr) => {
      const p = arr[i - 1], n = arr[i + 1];
      if (!p || !n || !(p.close > 0) || !(n.close > 0) || !(b.close > 0)) return true;
      const devP = Math.abs(b.close / p.close - 1), devN = Math.abs(b.close / n.close - 1);
      const neighbourGap = Math.abs(n.close / p.close - 1);
      if (devP > 0.15 && devN > 0.15 && neighbourGap < 0.12) { impossible++; return false; }
      return true;
    });
    console.log(`  ✓ ${sym}  ${before.length} 根(非原始價 ${beforeBad}) → 合併後 ${merged.length} 根(非原始價 0)；重抓覆蓋 ${fresh.length}、保留舊 ${keptOld}、丟棄還原價殘值 ${dropped}、丟棄物理不可能 bar ${impossible}`);
    if (APPLY) {
      copyFileSync(file, path.join(backupDir, `${sym}.json`));
      const { unlinkSync } = await import('fs');
      unlinkSync(file);
      invalidateEntry(sym, 'TW');
      await saveLocalCandles(sym, 'TW', merged);
    }
    ok++;
  }
  console.log(`\n完成：重抓 ${ok} 檔，跳過 ${skip}${APPLY ? `。備份在 ${path.basename(backupDir)}` : ' [dry-run]'}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
