// ============================================================
// L1 open-out-of-range 修補：把 open 落在 [low,high] 之外的 bar 重存過寫入層 sanitizeOHLC
// （現已對 open 一律 clip 不 drop）→ open 夾回範圍內，保留真實 H/L/C/V。
//
// 背景：TWSE/FinMind 對部分股票（創新板等高波動股）的 open 欄位回傳開盤集合競價/除權息參考價，
//   常落在當日 high/low 之外（非下載 bug，源頭即如此）。Yahoo/FinMind 都同值，重抓無效；
//   唯一正解是寫入層 clip。本腳本一次性把既有 L1 的舊壞 bar 過一遍 clip 修好。
//
// 用法：
//   npx tsx scripts/repair-l1-open-clamp.ts            # dry-run（只報告）
//   npx tsx scripts/repair-l1-open-clamp.ts --apply TW
//   npx tsx scripts/repair-l1-open-clamp.ts --apply TW CN
// ============================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import type { Candle } from '@/types';

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const markets = (ARGS.filter((a) => a === 'TW' || a === 'CN') as ('TW' | 'CN')[]);
if (markets.length === 0) markets.push('TW', 'CN');

(async () => {
  for (const market of markets) {
    const dir = path.join(process.cwd(), 'data/candles', market);
    const files = (await fs.readdir(dir)).filter((f) => /\.(TW|TWO|SS|SZ)\.json$/.test(f));
    const affected: { sym: string; bad: number }[] = [];
    for (const f of files) {
      let cs: Candle[];
      try { cs = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')).candles; } catch { continue; }
      if (!Array.isArray(cs)) continue;
      const bad = cs.filter((c) =>
        Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) &&
        c.low <= c.high && c.high > 0 && c.low > 0 && c.close > 0 &&
        (c.open <= 0 || c.open < c.low - 1e-6 || c.open > c.high + 1e-6),
      ).length;
      if (bad > 0) affected.push({ sym: f.replace('.json', ''), bad });
    }
    const totalBad = affected.reduce((s, a) => s + a.bad, 0);
    console.log(`\n[${market}] 受影響股 ${affected.length} 檔 / open 出界 bar ${totalBad} 根`);
    affected.sort((a, b) => b.bad - a.bad).slice(0, 15).forEach((a) => console.log(`  ${a.sym}: ${a.bad}`));

    if (!APPLY) { console.log(`  (dry-run，加 --apply 才寫入)`); continue; }
    let ok = 0;
    for (const { sym } of affected) {
      try {
        const cs = JSON.parse(await fs.readFile(path.join(dir, `${sym}.json`), 'utf8')).candles as Candle[];
        // 過寫入層：sanitizeOHLC 會把每根 open clip 進 [low,high]
        await saveLocalCandles(sym, market, cs.map((c) => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })));
        ok++;
      } catch (e) { console.warn(`  ✗ ${sym}: ${e instanceof Error ? e.message : e}`); }
    }
    console.log(`[${market}] 已重存修補 ${ok}/${affected.length} 檔`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
