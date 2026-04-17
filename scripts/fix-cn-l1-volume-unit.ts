/**
 * 修復 CN L1 4/16、4/17 volume 單位錯誤（手 → 股）
 *
 * 根因：append-today-from-snapshot 把 EastMoney/Tencent 的「手」直接寫成 L1 volume，
 * 但 L1 CN 標準是「股」。已修 script（× 100），但既存的 4/16/4/17 資料還是「手」。
 *
 * 判定：與前一日（4/15）volume 比，若 <10% 視為單位錯亂（× 100）。
 */

import { promises as fs } from 'fs';
import path from 'path';

async function main() {
  const dir = path.join('data', 'candles', 'CN');
  const files = await fs.readdir(dir);
  let patched = 0;

  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dir, f);
    try {
      const j = JSON.parse(await fs.readFile(p, 'utf-8'));
      const c = j.candles as { date: string; open: number; high: number; low: number; close: number; volume: number }[];
      if (!c || c.length === 0) continue;

      // 基準：近期「正常」volume 的中位數（跳過最後兩天 4/16 4/17 可能被污染）
      const refVols: number[] = [];
      for (let i = c.length - 3; i >= 0 && refVols.length < 20; i--) {
        if (c[i].volume > 0) refVols.push(c[i].volume);
      }
      if (refVols.length === 0) continue;
      refVols.sort((a, b) => a - b);
      const refMedian = refVols[Math.floor(refVols.length / 2)];
      if (refMedian < 10000) continue; // 小型股 baseline 太小，不修

      let dirty = false;
      for (const candle of c) {
        if (candle.date !== '2026-04-16' && candle.date !== '2026-04-17') continue;
        if (candle.volume <= 0) continue;
        const ratio = candle.volume / refMedian;
        // < 10% 基準 → 認定被 /100 寫錯，恢復 × 100
        if (ratio < 0.1) {
          candle.volume = candle.volume * 100;
          dirty = true;
          patched++;
        }
      }

      if (dirty) {
        j.updatedAt = new Date().toISOString();
        await fs.writeFile(p, JSON.stringify(j), 'utf-8');
      }
    } catch { /* skip */ }
  }

  console.log(`修正 ${patched} 根 CN L1 K 棒 (volume × 100)`);
}

main().catch(err => { console.error(err); process.exit(1); });
