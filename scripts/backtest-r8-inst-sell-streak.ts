/**
 * R8「法人連續賣超」淘汰法復活回測（CH5-03 記待回測，2026-07-05）
 *
 * 書本 R8：法人連續賣超的股票淘汰（別買）。當年因無資料移除；現在 inst 資料齊了。
 * 這是「避雷側」檢定：被 R8 標記的股票之後是否**系統性弱於同日宇宙平均**（去 beta）。
 *
 * 方法：
 * - 宇宙 = 有 K 線 + 有法人資料 + 當日成交額 ≥ 5000 萬的股票日
 * - sellStreak = 截至當日的法人連續賣超天數（inst total < 0；資料缺日保守斷鏈）
 * - 前瞻 D5/D10/D20 = close[t+N]/close[t] − 1，一律減同日宇宙平均（去 beta）
 * - 分桶 0 / 1 / 2 / 3-4 / ≥5，train/test 對半
 * - 結論標準：≥3 桶在 train 與 test 都顯著為負 → R8 可復活為避雷標示（顯示層）
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const FROM = '2024-07-01';
const MIN_TURNOVER = 50_000_000; // 5000 萬
const HORIZONS = [5, 10, 20] as const;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }

interface Obs {
  date: string;
  streak: number;
  fwd: Record<number, number>; // horizon → raw return %
}

async function main() {
  const instFiles = (await fs.readdir(INST)).filter(f => /^\d{4}\.json$/.test(f));
  const obs: Obs[] = [];

  for (const f of instFiles) {
    const code = f.replace('.json', '');
    // inst 檔多為上市；上櫃 K 線在 .TWO — 兩邊都試
    const cdl = (await readJ(path.join(C, `${code}.TW.json`))) ?? (await readJ(path.join(C, `${code}.TWO.json`)));
    if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0);
    if (cs.length < 60) continue;
    const ins = await readJ(path.join(INST, f));
    const im = new Map<string, number>();
    for (const d of (ins?.data || [])) im.set(d.date, d.total ?? 0);
    if (im.size < 60) continue;

    for (let t = 10; t + 20 < cs.length; t++) {
      if (cs[t].date < FROM) continue;
      if (cs[t].close * (cs[t].volume || 0) * 1000 < MIN_TURNOVER) continue; // TW L1 volume 單位=張
      if (!im.has(cs[t].date)) continue; // 當日無法人資料 → 不觀測
      // 連續賣超天數（沿 K 線日往回走；缺法人資料日=斷鏈，保守）
      let streak = 0;
      for (let k = t; k >= 0; k--) {
        const v = im.get(cs[k].date);
        if (v == null || v >= 0) break;
        streak++;
      }
      const fwd: Record<number, number> = {};
      for (const h of HORIZONS) fwd[h] = (cs[t + h].close / cs[t].close - 1) * 100;
      obs.push({ date: cs[t].date, streak, fwd });
    }
  }

  obs.sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`觀測數 ${obs.length}（${obs[0]?.date} ~ ${obs[obs.length - 1]?.date}）`);

  // 同日宇宙平均（去 beta 基準）
  const dayMean = new Map<string, Record<number, { s: number; n: number }>>();
  for (const o of obs) {
    const m = dayMean.get(o.date) ?? Object.fromEntries(HORIZONS.map(h => [h, { s: 0, n: 0 }]));
    for (const h of HORIZONS) { m[h].s += o.fwd[h]; m[h].n++; }
    dayMean.set(o.date, m);
  }
  const excess = (o: Obs, h: number) => {
    const m = dayMean.get(o.date)![h];
    return o.fwd[h] - m.s / m.n;
  };

  const mid = obs[Math.floor(obs.length / 2)].date;
  const bucketOf = (s: number) => (s >= 5 ? '≥5' : s >= 3 ? '3-4' : String(s));
  const BUCKETS = ['0', '1', '2', '3-4', '≥5'];

  for (const [name, pool] of [['train（前半）', obs.filter(o => o.date < mid)], ['test（後半）', obs.filter(o => o.date >= mid)]] as const) {
    console.log(`\n===== ${name}  n=${pool.length}  分界 ${mid} =====`);
    console.log('連賣桶     n        D5超額    D10超額   D20超額   D20勝率(vs宇宙)');
    for (const b of BUCKETS) {
      const rows = pool.filter(o => bucketOf(o.streak) === b);
      if (rows.length < 30) { console.log(`${b.padEnd(6)} ${String(rows.length).padStart(7)}  (樣本太少)`); continue; }
      const stat = HORIZONS.map(h => {
        const xs = rows.map(o => excess(o, h));
        return xs.reduce((s, x) => s + x, 0) / xs.length;
      });
      const winRate = rows.filter(o => excess(o, 20) > 0).length / rows.length * 100;
      console.log(
        `${b.padEnd(6)} ${String(rows.length).padStart(7)}  ` +
        stat.map(x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(8)).join('  ') +
        `  ${winRate.toFixed(0)}%`,
      );
    }
  }
  console.log('\n判讀：R8 可復活的條件 = 連賣 ≥3 桶在 train 與 test 的 D5~D20 超額都穩定為負。');
}
main().catch(e => { console.error(e); process.exit(1); });
