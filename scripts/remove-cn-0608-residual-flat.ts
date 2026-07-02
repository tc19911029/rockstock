/**
 * 移除 2026-06-08 殘留壞平棒（repair-cn-0608-flat-seal 後仍 flat 的 ~19 檔：
 * L2 缺/仍平棒、或 saveLocalCandles 漲跌停 guard 擋下新棒導致舊平棒留著）。
 * 直接改 JSON 把那根移掉（saveLocalCandles 是按日期 merge、無法用來「刪」）。
 * 移掉後走圖會即時注入補今日、下次盤後 append-from-snapshot（已加新鮮度守衛）再正確封存。
 *
 * 用法：npx tsx scripts/remove-cn-0608-residual-flat.ts        # dry-run
 *       APPLY=1 npx tsx scripts/remove-cn-0608-residual-flat.ts
 */
import { readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { Candle } from '@/types';

const TARGET = '2026-06-08';
const DIR = 'data/candles/CN';
const APPLY = process.env.APPLY === '1';
const isFlat = (b: Candle) => b.open === b.high && b.high === b.low && b.low === b.close;

let removed = 0;
const samples: string[] = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  const fp = path.join(DIR, f);
  let data: { symbol?: string; lastDate?: string; sealedDate?: string; candles?: Candle[] };
  try { data = JSON.parse(readFileSync(fp, 'utf8')); } catch { continue; }
  const c = data.candles;
  if (!Array.isArray(c) || c.length < 2) continue;
  const last = c[c.length - 1];
  if (last.date !== TARGET || !isFlat(last)) continue;

  const next = c.slice(0, -1);
  const newLast = next[next.length - 1].date;
  data.candles = next;
  data.lastDate = newLast;
  if (data.sealedDate && data.sealedDate >= TARGET) data.sealedDate = newLast;
  if (samples.length < 20) samples.push(`${f.replace('.json', '')}(${last.close}→移除,lastDate=${newLast})`);
  if (APPLY) {
    const tmp = `${fp}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, fp); // 原子替換
  }
  removed++;
}
console.log(APPLY ? '【已移除】' : '【DRY-RUN】', `殘留平棒移除: ${removed}`);
console.log('樣本:', samples.join('  '));
