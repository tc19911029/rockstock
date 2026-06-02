// ============================================================
// 台股 L1 污染根除：重抓乾淨基底 + 前復權(qfq) 比例接合，消除「不可能的 >25% 單日跳」。
//   - 為什麼重抓：本地舊資料混了已棄用的 Yahoo adjclose 刻度 + 慢性 glitch（如 4806 16 根半價掉）；
//     pipeline 重抓（FinMind unadjusted，Yahoo 已棄用）= 乾淨基底，通常只剩 ≤1 個「真實除權/減資/分割」跳。
//   - 接合(qfq)：對每個「持續性」跳（+2 日後仍偏離=真實公司行動，非當日波動），把該日「之前」全部 OHLC
//     乘以 gap ratio → 該日不再跳、序列自洽。等同補上 pipeline 漏掉的 split 調整（合 2026-05-21 split-only 政策）。
//   - glitch（單日 >40% 且兩側鄰居吻合=尖刺即回）→ 內插平根（極少，重抓後基本沒了）。
// 安全：重抓→記憶體清乾淨→saveLocalCandles 覆寫；覆寫前備份原檔到 data/candles/TW-backup-contam-<ts>/。
//
//   npx tsx scripts/repair-tw-contamination.ts 8422.TW 2327.TW 4806.TWO 8476.TW   # dry-run 指定股
//   npx tsx scripts/repair-tw-contamination.ts --from-sweep                        # dry-run sweep 全部 TW 污染股
//   npx tsx scripts/repair-tw-contamination.ts --from-sweep --apply                # 真改
// ============================================================
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { invalidateEntry } from '@/lib/datasource/L1CandleCache';
import type { Candle } from '@/types';

const APPLY = process.argv.includes('--apply');
const FROM_SWEEP = process.argv.includes('--from-sweep');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const DIR = path.join(process.cwd(), 'data/candles/TW');

const maxJump = (cs: Candle[]) => {
  let m = 0, at = '';
  for (let i = 1; i < cs.length; i++) { const p = cs[i - 1].close, c = cs[i].close; if (p > 0 && c > 0) { const d = Math.abs(c / p - 1); if (d > m) { m = d; at = String(cs[i].date); } } }
  return { pct: +(m * 100).toFixed(0), at };
};

/** 清乾淨：先內插孤立 glitch，再前復權接合持續性跳。回傳 {cs, glitches, splices}。 */
function clean(input: Candle[]): { cs: Candle[]; glitches: number; splices: { date: string; k: number }[] } {
  const cs = input.map((c) => ({ ...c }));
  let glitches = 0;
  // 1) 孤立 glitch：單日 >40% 且兩側鄰居吻合<15%、且非相鄰另一 glitch → 內插
  for (let i = 1; i < cs.length - 1; i++) {
    const p = cs[i - 1].close, c = cs[i].close, n = cs[i + 1].close;
    if (!(p > 0 && c > 0 && n > 0)) continue;
    if (Math.abs(c / p - 1) > 0.40 && Math.abs(c / n - 1) > 0.40 && Math.abs(n / p - 1) < 0.15) {
      const fix = +((p + n) / 2).toFixed(4);
      cs[i].open = fix; cs[i].high = fix; cs[i].low = fix; cs[i].close = fix; glitches++;
    }
  }
  // 2) 持續性跳（真實公司行動）→ 前復權：bar j 乘以 (其後所有事件 gap ratio 之積)
  const events: { i: number; k: number; date: string }[] = [];
  for (let i = 1; i < cs.length; i++) {
    const p = cs[i - 1].close, c = cs[i].close;
    if (!(p > 0 && c > 0)) continue;
    if (Math.abs(c / p - 1) <= 0.25) continue;
    const after = cs[Math.min(i + 2, cs.length - 1)].close;
    if (Math.abs(after / p - 1) > 0.15) events.push({ i, k: c / p, date: String(cs[i].date) }); // 持續=真實事件
  }
  for (let j = 0; j < cs.length; j++) {
    let scale = 1;
    for (const e of events) if (e.i > j) scale *= e.k;
    if (scale !== 1) { cs[j].open *= scale; cs[j].high *= scale; cs[j].low *= scale; cs[j].close *= scale; }
  }
  return { cs, glitches, splices: events.map((e) => ({ date: e.date, k: +e.k.toFixed(3) })) };
}

async function collectSyms(): Promise<string[]> {
  if (FROM_SWEEP) {
    const o = JSON.parse(await fs.readFile('/tmp/sanse-data-sweep.json', 'utf8'));
    const syms = new Set<string>();
    for (const r of o.twRes ?? []) if ((r.flags ?? []).some((f: string) => f.startsWith('contamination'))) syms.add(r.sym);
    return [...syms];
  }
  return process.argv.slice(2).filter((a) => /^\d{4,6}\.(TW|TWO)$/.test(a));
}

(async () => {
  const syms = await collectSyms();
  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — ${syms.length} 檔台股污染修復\n`);
  const backupDir = path.join(process.cwd(), 'data/candles', `TW-backup-contam-${STAMP}`);
  let okCount = 0, badCount = 0;
  for (const sym of syms) {
    let fresh: Candle[];
    try { fresh = await dataProvider.getHistoricalCandles(sym, '5y', undefined, '1d'); }
    catch (e: any) { console.log(`  ${sym.padEnd(11)} 重抓失敗 ${String(e.message).slice(0, 40)}`); badCount++; continue; }
    if (!Array.isArray(fresh) || fresh.length < 60) { console.log(`  ${sym.padEnd(11)} 重抓 <60 根，跳過`); badCount++; continue; }
    const before = maxJump(fresh);
    const { cs, glitches, splices } = clean(fresh);
    const after = maxJump(cs);
    const status = after.pct < 25 ? '✓' : '⚠仍有跳';
    if (after.pct < 25) okCount++; else badCount++;
    console.log(`  ${sym.padEnd(11)} n=${cs.length} 重抓maxJump=${before.pct}%@${before.at} → 修後=${after.pct}%@${after.at} ${status}  glitch:${glitches} splice:${splices.map((s) => s.date + '×' + s.k).join(',') || '無'}`);
    if (APPLY && after.pct < 25) {
      await fs.mkdir(backupDir, { recursive: true });
      const file = `${sym}.json`;
      try { await fs.copyFile(path.join(DIR, file), path.join(backupDir, file)); } catch { /* 原檔不存在(新股)=不用備份 */ }
      // 必須先刪原檔 + 清 L1 記憶體快取，否則 saveLocalCandles 會把舊污染 bar 當 existing「按日期 merge」回來
      // → qfq 縮放後的乾淨 bar 跟未縮放舊 bar 混在一起，反而造出新接合（見 repair-cn-unadjusted-splice 同款處理）
      await fs.unlink(path.join(DIR, file)).catch(() => {});
      invalidateEntry(sym, 'TW');
      await saveLocalCandles(sym, 'TW', cs);
    }
  }
  console.log(`\n結果：${okCount} 乾淨${APPLY ? '（已修+備份）' : ''}，${badCount} 仍需查`);
  if (APPLY) console.log(`備份：${backupDir}`);
  else console.log('（dry-run；加 --apply 才覆寫）');
})();
