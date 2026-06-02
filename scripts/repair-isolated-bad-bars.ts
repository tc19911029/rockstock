// ============================================================
// 孤立壞 bar 修復（TW + CN）：單日 |move| > 40%（遠超 ±10/±20% 漲跌停 = 不可能真實成交）
// 且「兩側鄰居互相吻合（<15%）」= 該根是孤立離群尖刺（如 8422.TW 19.3→191.5→19.25），
// 非除權/減資的持續接合（那種 +2 日後仍偏離，留給另一條接合處理，不在此修）。
//
// 修法：把該根 OHLC 用左右鄰居線性內插取代（close=(prev+next)/2），volume 保留。
//   → 讓本地序列自洽、三色/均線不再被尖刺帶歪；不碰調整基準（不做還權）。
// 安全：先備份到 data/candles/<MKT>-backup-badbar-<ts>/，再用 invalidateEntry 清 L1 cache。
//
//   npx tsx scripts/repair-isolated-bad-bars.ts            # dry-run，只列出
//   npx tsx scripts/repair-isolated-bad-bars.ts --apply
// ============================================================
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Candle } from '@/types';

const APPLY = process.argv.includes('--apply');
const SPIKE = 0.40;     // 單日 > 40% 才算（漲跌停不可能）
const AGREE = 0.15;     // 兩側鄰居吻合門檻 = 孤立尖刺（非持續接合）
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

interface Hit { i: number; date: string; prev: number; bad: number; next: number; fix: number; }

function detect(cs: Candle[]): Hit[] {
  const out: Hit[] = [];
  for (let i = 1; i < cs.length - 1; i++) {
    const p = cs[i - 1].close, c = cs[i].close, n = cs[i + 1].close;
    if (!(p > 0 && c > 0 && n > 0)) continue;
    if (Math.abs(c / p - 1) <= SPIKE) continue;          // 該日相對前一日跳動 > 40%
    if (Math.abs(n / p - 1) > AGREE) continue;            // 鄰居不吻合 → 可能是持續接合/真實趨勢，跳過
    if (Math.abs(c / n - 1) <= SPIKE) continue;           // 該日相對後一日也要 > 40%（確認是該根離群）
    out.push({ i, date: String(cs[i].date).replace('*', ''), prev: p, bad: c, next: n, fix: +((p + n) / 2).toFixed(4) });
  }
  // 相鄰壞 bar（互相在 3 根內）= 連續污染段，內插會用到另一根壞值 → 不在此修，留給整段重抓
  return out.filter((h, k) => {
    const prevH = out[k - 1], nextH = out[k + 1];
    if (prevH && h.i - prevH.i <= 3) return false;
    if (nextH && nextH.i - h.i <= 3) return false;
    return true;
  });
}

async function run(market: 'TW' | 'CN') {
  const dir = path.join(process.cwd(), 'data/candles', market);
  let files: string[];
  try { files = (await fs.readdir(dir)).filter((f) => /^\d{4,6}\.(TW|TWO|SS|SZ)\.json$/.test(f) && !f.startsWith('000001.SS')); }
  catch { return { market, affected: [] as { sym: string; hits: Hit[] }[] }; }
  const affected: { sym: string; hits: Hit[] }[] = [];
  for (const f of files) {
    let j: { candles: Candle[] };
    try { j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(j.candles)) continue;
    const hits = detect(j.candles);
    if (!hits.length) continue;
    affected.push({ sym: f.replace('.json', ''), hits });
    if (APPLY) {
      const backupDir = path.join(process.cwd(), 'data/candles', `${market}-backup-badbar-${STAMP}`);
      await fs.mkdir(backupDir, { recursive: true });
      await fs.copyFile(path.join(dir, f), path.join(backupDir, f));
      for (const h of hits) {
        const b = j.candles[h.i];
        b.open = h.fix; b.high = h.fix; b.low = h.fix; b.close = h.fix; // 內插平根（保留 volume）
      }
      await fs.writeFile(path.join(dir, f), JSON.stringify(j));
      try { const { invalidateEntry } = await import('@/lib/datasource/L1CandleCache'); invalidateEntry(f.replace('.json', ''), market); } catch { /* cache 清不到不致命 */ }
    }
  }
  return { market, affected };
}

(async () => {
  const tw = await run('TW');
  const cn = await run('CN');
  for (const r of [tw, cn]) {
    const bars = r.affected.reduce((s, a) => s + a.hits.length, 0);
    console.log(`\n=== ${r.market}: ${r.affected.length} 檔 / ${bars} 根孤立壞 bar ${APPLY ? '（已修+備份）' : '(dry-run)'} ===`);
    for (const a of r.affected) for (const h of a.hits)
      console.log(`  ${a.sym.padEnd(11)} ${h.date}  ${h.prev} → ${h.bad} → ${h.next}   修成 ${h.fix}`);
  }
  if (!APPLY) console.log('\n(dry-run；加 --apply 才會備份+覆寫+清 L1 cache)');
  else console.log(`\n備份目錄：data/candles/{TW,CN}-backup-badbar-${STAMP}/`);
})();
