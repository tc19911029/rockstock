// ============================================================
// 台股 L1 成交量單位修復 — 顯式範圍版（人工逐檔核對後的「確定股段」與「孤立單日尖刺」）
//
// 給 repair-tw-volume-unit-splice.ts 自動修不到、但人工已確認是「股」的案例：
//   - 確定股段：絕對量級遠超任何可能的張(全台股單日最高 ~16 萬張)，或 ratio ~1000×
//     卻因「邊界價也跳/比例落在 100–300× 死區」被自動版擋下。1000× 量變化不可能來自
//     任何公司行動(分割最多 1:10)，故價跳不影響「成交量該 ÷1000」。
//   - 孤立單日尖刺：2025-08-01 一批 OTC 微型股單日爆量 glitch(微型股不可能單日 38 萬張)等。
//
// 規則：對每筆 (symbol, from?, to?, minVol) 範圍內、volume > minVol 的 bar ÷1000。
//   minVol 設遠高於該檔「張」量級 → 只打到「股」bar，碰不到正常張 bar。
//
//   npx tsx scripts/repair-tw-volume-explicit.ts          # dry-run
//   npx tsx scripts/repair-tw-volume-explicit.ts --apply
// ============================================================
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Candle } from '@/types';

const APPLY = process.argv.includes('--apply');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

interface Job { sym: string; from?: string; to?: string; minVol: number; note: string; }
const JOBS: Job[] = [
  // ── 確定股段(÷1000)：絕對量級不可能是張，或 ratio~1000× 只因邊界價跳被擋 ──
  { sym: '2374.TW', to: '2021-04-15', minVol: 50_000, note: '2016–2021 段 med 48.5萬=股(張僅~3千)' },
  { sym: '8033.TW', from: '2017-01-24', to: '2021-04-15', minVol: 50_000, note: '2017–2021 兩段 22–33萬=股(留 5866 那2根 glitch)' },
  { sym: '1445.TW', to: '2024-05-20', minVol: 50_000, note: '早 23 根 med 56.5萬=股(張僅~80)，邊界價跳屬另案' },
  { sym: '2762.TW', to: '2024-05-20', minVol: 50_000, note: '早 23 根 16.9萬=股 2678×，邊界價跳屬另案' },
  // ── 孤立單日量尖刺(÷1000)：2025-08-01 一批 OTC 微型股單日爆量 glitch；只打那一天，
  //    避免誤砍「張」era 真實爆量日(如 8043 2025-11-19 的 9 萬可能是真量)。其餘曖昧根另查。
  { sym: '3349.TWO', from: '2025-08-01', to: '2025-08-01', minVol: 50_000, note: '2025-08-01 單日 38萬 glitch(張~16–229)' },
  { sym: '6532.TWO', from: '2025-08-01', to: '2025-08-01', minVol: 50_000, note: '2025-08-01 單日 21萬 glitch(張~128–181)' },
  { sym: '8043.TWO', from: '2025-08-01', to: '2025-08-01', minVol: 50_000, note: '2025-08-01 單日 46萬 glitch(張~168)' },
  { sym: '8935.TWO', from: '2025-08-01', to: '2025-08-01', minVol: 50_000, note: '2025-08-01 單日 30萬 glitch(張~104)' },
  { sym: '9136.TW',  from: '2025-08-01', to: '2025-08-01', minVol: 50_000, note: '2025-08-01 單日 22萬 glitch(張~244)' },
  { sym: '7556.TWO', from: '2025-08-01', to: '2025-08-01', minVol: 30_000, note: '2025-08-01 單日 5.8萬 glitch(張~24)' },
  { sym: '6432.TWO', from: '2025-08-01', to: '2025-08-01', minVol: 30_000, note: '2025-08-01 單日 4.5萬 glitch(張~71)' },
  { sym: '6538.TWO', from: '2025-08-01', to: '2025-08-01', minVol: 30_000, note: '2025-08-01 單日 4.5萬 glitch(張~108)' },
  { sym: '7704.TWO', from: '2025-08-01', to: '2025-08-01', minVol: 10_000, note: '2025-08-01 單日 2.2萬 glitch(張~17)' },
  { sym: '8444.TWO', from: '2025-08-01', to: '2025-08-01', minVol: 2_000, note: '2025-08-01 單日 4029 glitch(張~17)' },
  // ── 上網對 ground truth 後確認(群創/2250) ──
  // 3481 群創：2026-05 起進入大行情、近期成交量本就數十萬張(web 證實 2026-05-06 ~84.4萬張)，
  //   故近期 ≥1M 是「張」不可動；只動 2024-04-25~2026-04-24 與 2026-04-29~30 的「股」段(53M/118M)。
  // ⚠ 已於 2026-06-02 套用一次。**勿再 --apply**：群創有 ≥10 億股(÷1000 後仍 ≥1M 張)的真實大量日，
  //   重跑會把這些已是「張」的大量日再 ÷1000 砍壞。故下兩行已停用(留作紀錄)。
  // { sym: '3481.TW', from: '2024-04-25', to: '2026-04-24', minVol: 1_000_000, note: '群創 股段(53M)→張(已套用)' },
  // { sym: '3481.TW', from: '2026-04-29', to: '2026-04-30', minVol: 1_000_000, note: '群創 2026-04-29~30 1.18億股 glitch→張(已套用)' },
  // 2250：近期僅 ~150 張/日(局部極低量股)，118857/467330/90100 三段量級不可能是張 → 全是股
  { sym: '2250.TW', minVol: 50_000, note: '~150張/日股，≥5萬皆股段(早23根/2025-08五根/2025-11~2026-03 九十一根)→張' },
];

(async () => {
  const dir = path.join(process.cwd(), 'data/candles/TW');
  const backupDir = path.join(process.cwd(), 'data/candles', `TW-backup-volexplicit-${STAMP}`);
  for (const j of JOBS) {
    const fp = path.join(dir, `${j.sym}.json`);
    let raw: string;
    try { raw = await fs.readFile(fp, 'utf8'); } catch { console.log(`  ${j.sym.padEnd(11)} ⚠ 讀不到，跳過`); continue; }
    const data = JSON.parse(raw) as { candles: Candle[] };
    const hits: { date: string; before: number; after: number }[] = [];
    for (const c of data.candles) {
      const d = String(c.date).replace('*', '');
      if (j.from && d < j.from) continue;
      if (j.to && d > j.to) continue;
      if (c.volume > j.minVol) hits.push({ date: d, before: c.volume, after: Math.round(c.volume / 1000) });
    }
    console.log(`  ${j.sym.padEnd(11)} ${String(hits.length).padStart(4)} 根 >${j.minVol}  ${j.note}`);
    if (hits.length) console.log(`      範例: ${hits[0].date} ${hits[0].before}→${hits[0].after}  …  ${hits[hits.length - 1].date} ${hits[hits.length - 1].before}→${hits[hits.length - 1].after}`);
    if (APPLY && hits.length) {
      await fs.mkdir(backupDir, { recursive: true });
      // 只在「本次執行尚未備份過該檔」時備份原檔（同檔多 job 時不可用已改檔覆蓋備份）
      const bkp = path.join(backupDir, `${j.sym}.json`);
      try { await fs.access(bkp); } catch { await fs.copyFile(fp, bkp); }
      for (const c of data.candles) {
        const d = String(c.date).replace('*', '');
        if (j.from && d < j.from) continue;
        if (j.to && d > j.to) continue;
        if (c.volume > j.minVol) c.volume = Math.round(c.volume / 1000);
      }
      await fs.writeFile(fp, JSON.stringify(data));
      try { const { invalidateEntry } = await import('@/lib/datasource/L1CandleCache'); invalidateEntry(j.sym, 'TW'); }
      catch { /* 清不到不致命 */ }
    }
  }
  console.log(APPLY ? `\n已修+備份到 ${backupDir}` : '\n(dry-run；加 --apply 才會備份+覆寫+清 cache)');
})();
