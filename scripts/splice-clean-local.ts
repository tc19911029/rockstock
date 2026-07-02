// ============================================================
// 殘留接合「就地」清理（不重抓）：對已在 L1 的資料反覆「內插孤立 glitch + 前復權接合持續性跳」，
// 直到無 >25% 不可能跳，或達 maxPass。用於：CN Tencent-qfq 自己仍跳的殘留、TW 單次接合後仍 ⚠ 的股。
//   - 只動 ACTIVE 股（最後一根 >= ACTIVE_SINCE）；死亡/下市股的真實崩跌不碰。
//   - 安全：unlink + invalidateEntry + saveLocalCandles（避免 merge 回舊污染）；備份到 <MKT>-backup-spliceclean-<ts>/。
//
//   npx tsx scripts/splice-clean-local.ts --from-sweep            # dry-run，列出 active 殘留污染股
//   npx tsx scripts/splice-clean-local.ts --from-sweep --apply
// ============================================================
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { invalidateEntry } from '@/lib/datasource/L1CandleCache';
import type { Candle } from '@/types';

const APPLY = process.argv.includes('--apply');
const ACTIVE_SINCE = '2026-05-20';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const maxJump = (cs: Candle[]) => { let m = 0, at = ''; for (let i = 1; i < cs.length; i++) { const p = cs[i - 1].close, c = cs[i].close; if (p > 0 && c > 0) { const d = Math.abs(c / p - 1); if (d > m) { m = d; at = String(cs[i].date); } } } return { pct: +(m * 100).toFixed(0), at }; };

/** 一趟清理：內插孤立 glitch + 前復權接合所有 >25% 持續跳。回傳是否有改動。 */
function onePass(cs: Candle[]): boolean {
  let changed = false;
  // 內插孤立 glitch（單日 >40% 且兩側鄰居吻合）
  for (let i = 1; i < cs.length - 1; i++) {
    const p = cs[i - 1].close, c = cs[i].close, n = cs[i + 1].close;
    if (!(p > 0 && c > 0 && n > 0)) continue;
    // >25% 偏離兩側、且兩側互相吻合(<15%) = 孤立尖刺即回 → 內插（真實波動不會隔天就回到原位，故安全）
    if (Math.abs(c / p - 1) > 0.25 && Math.abs(c / n - 1) > 0.25 && Math.abs(n / p - 1) < 0.15) {
      const fix = +((p + n) / 2).toFixed(4); cs[i].open = cs[i].high = cs[i].low = cs[i].close = fix; changed = true;
    }
  }
  // 前復權：每個 >25% 跳（持續=真實事件 / 殘留接合）→ 把之前全部 *k
  const events: { i: number; k: number }[] = [];
  for (let i = 1; i < cs.length; i++) {
    const p = cs[i - 1].close, c = cs[i].close;
    if (!(p > 0 && c > 0) || Math.abs(c / p - 1) <= 0.25) continue;
    const after = cs[Math.min(i + 2, cs.length - 1)].close;
    if (Math.abs(after / p - 1) > 0.15) events.push({ i, k: c / p });
  }
  for (let j = 0; j < cs.length; j++) { let s = 1; for (const e of events) if (e.i > j) s *= e.k; if (s !== 1) { cs[j].open *= s; cs[j].high *= s; cs[j].low *= s; cs[j].close *= s; changed = true; } }
  return changed;
}

function clean(input: Candle[]): { cs: Candle[]; passes: number } {
  let cs = input.map((c) => ({ ...c }));
  let passes = 0;
  for (; passes < 6; passes++) { if (maxJump(cs).pct < 25) break; if (!onePass(cs)) break; }
  return { cs, passes };
}

async function collect(market: 'TW' | 'CN'): Promise<string[]> {
  const o = JSON.parse(await fs.readFile('/tmp/sanse-data-sweep.json', 'utf8'));
  const res = market === 'CN' ? o.cnRes : o.twRes;
  return (res ?? []).filter((r: any) => (r.flags ?? []).some((f: string) => f.startsWith('contamination')) && r.lastDate >= ACTIVE_SINCE).map((r: any) => r.sym);
}

async function run(market: 'TW' | 'CN') {
  const dir = path.join(process.cwd(), 'data/candles', market);
  const syms = await collect(market);
  console.log(`\n=== ${market}: ${syms.length} active 殘留污染股 ${APPLY ? '(apply)' : '(dry-run)'} ===`);
  const backupDir = path.join(process.cwd(), 'data/candles', `${market}-backup-spliceclean-${STAMP}`);
  let ok = 0, bad = 0;
  for (const sym of syms) {
    let j: { candles: Candle[] };
    try { j = JSON.parse(await fs.readFile(path.join(dir, `${sym}.json`), 'utf8')); } catch { console.log(`  ${sym} 讀取失敗`); bad++; continue; }
    if (!Array.isArray(j.candles) || j.candles.length < 60) { bad++; continue; }
    const before = maxJump(j.candles);
    const { cs, passes } = clean(j.candles);
    const after = maxJump(cs);
    const good = after.pct < 25;
    console.log(`  ${sym.padEnd(11)} ${before.pct}%@${before.at} → ${after.pct}%@${after.at} (${passes}趟) ${good ? '✓' : '⚠仍跳'}`);
    if (good) ok++; else bad++;
    if (APPLY && good) {
      await fs.mkdir(backupDir, { recursive: true });
      await fs.copyFile(path.join(dir, `${sym}.json`), path.join(backupDir, `${sym}.json`)).catch(() => {});
      await fs.unlink(path.join(dir, `${sym}.json`)).catch(() => {});
      invalidateEntry(sym, market);
      await saveLocalCandles(sym, market, cs);
    }
  }
  console.log(`  → ${ok} 乾淨${APPLY ? '(已修)' : ''}, ${bad} 仍需查`);
  if (APPLY) console.log(`  備份：${backupDir}`);
}

(async () => { await run('CN'); await run('TW'); if (!APPLY) console.log('\n(dry-run；加 --apply 才覆寫)'); })();
