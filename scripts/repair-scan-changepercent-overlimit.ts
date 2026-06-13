/**
 * 修掃描紀錄裡「物理上不可能」的漲跌幅（|changePercent| > 25%，遠超 TW±10/CN±20 漲跌停）。
 *
 * 根因：盤中快照算 changePercent 時拿到 stale 參考價（幾天前的前收）→ price 欄正確、但
 * changePercent 用錯前收。不污染 L1、不污染回測（回測讀 L1 重算），但污染 /health 掃描歷史。
 *
 * 修法：用 L1 該股「掃描日前一交易日的 close」當前收，重算 changePercent = (price/prevClose−1)×100。
 * 只在重算結果落回合理範圍（|.| ≤ 22）時覆寫；否則保留原值並標出（避免硬改成更怪的值）。
 *
 *   npx tsx scripts/repair-scan-changepercent-overlimit.ts          # dry-run
 *   npx tsx scripts/repair-scan-changepercent-overlimit.ts --apply
 */

import fs from 'fs';
import path from 'path';

const DATA = path.join(process.cwd(), 'data');
const APPLY = process.argv.includes('--apply');
const THRESHOLD = 25;   // |cp| 超過此值 = 不可能、視為髒
const SANE = 22;        // 重算後落在此範圍內才覆寫（涵蓋 CN ±20 + 小緩衝）

interface Candle { date: string; close: number }
const l1: Record<string, Candle[] | null> = {};
function loadL1(market: string, symbol: string): Candle[] | null {
  const key = `${market}/${symbol}`;
  if (l1[key] === undefined) {
    try { l1[key] = (JSON.parse(fs.readFileSync(path.join(DATA, 'candles', market, `${symbol}.json`), 'utf8')).candles ?? null); }
    catch { l1[key] = null; }
  }
  return l1[key];
}
function prevClose(market: string, symbol: string, scanDate: string): number | null {
  const cs = loadL1(market, symbol);
  if (!cs) return null;
  let pc: number | null = null;
  for (const c of cs) {
    const dd = String(c.date).slice(0, 10);
    if (dd < scanDate && c.close > 0) pc = c.close;
    else if (dd >= scanDate) break;
  }
  return pc;
}

function main(): void {
  const files = fs.readdirSync(DATA).filter((f) => /^scan-(CN|TW)-long-.*\.json$/.test(f));
  let changedFiles = 0, fixedRecords = 0, skipped = 0;
  const sample: string[] = [];

  for (const f of files) {
    const market = f.startsWith('scan-CN') ? 'CN' : 'TW';
    let d: { date?: string; results?: { symbol?: string; name?: string; price?: number; changePercent?: number }[] };
    try { d = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
    const results = d.results ?? [];
    let dirty = false;
    for (const r of results) {
      if (Math.abs(r.changePercent ?? 0) <= THRESHOLD) continue;
      const pc = r.symbol && d.date ? prevClose(market, r.symbol, d.date) : null;
      if (pc && pc > 0 && r.price && r.price > 0) {
        const trueCp = +((r.price / pc - 1) * 100).toFixed(2);
        if (Math.abs(trueCp) <= SANE) {
          if (sample.length < 10) sample.push(`  ${f} | ${r.symbol} ${r.name} ${d.date}: ${r.changePercent}% → ${trueCp}%`);
          r.changePercent = trueCp;
          dirty = true; fixedRecords++;
          continue;
        }
      }
      skipped++;
    }
    if (dirty) { changedFiles++; if (APPLY) fs.writeFileSync(path.join(DATA, f), JSON.stringify(d)); }
  }

  console.log(`\n  ${APPLY ? '【已修】' : '【DRY-RUN，加 --apply 才改】'}`);
  console.log(`  受影響檔: ${changedFiles}　重算紀錄: ${fixedRecords}　無法重算保留: ${skipped}`);
  console.log(sample.join('\n'));
}

main();
