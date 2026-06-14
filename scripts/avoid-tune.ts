/**
 * 避雷訊號調校 — 在「液態股」裡找「被主力/法人倒貨 → 該避開」的最佳門檻
 *   每(股,日)算 主力分點/法人 5日集中度(負=在倒)，掃門檻看「之後20日超額 + 贏大盤% + 涵蓋數」
 *   目標：贏大盤<40%(避得準) 且 涵蓋夠多(>2000筆)。進場隔日開盤、持有20日、超額對^TWII。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const FWD = 20;

interface OHLC { date: string; open: number; close: number; volume: number }
interface Row { brkConc: number | null; instConc: number | null; turnover: number; iso: string; excess: number }

async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }

function stat(label: string, rows: Row[], pick: (r: Row) => boolean) {
  const s = rows.filter(pick);
  if (s.length < 50) { console.log(`  ${label.padEnd(30)} ${s.length}筆(太少)`); return; }
  const ex = s.reduce((x, r) => x + r.excess, 0) / s.length;
  const win = 100 * s.filter(r => r.excess > 0).length / s.length;
  console.log(`  ${label.padEnd(30)} ${String(s.length).padStart(6)}筆 | 超額${ex >= 0 ? '+' : ''}${ex.toFixed(2)}% | 贏大盤${win.toFixed(0)}%`);
}

async function main() {
  const twii: OHLC[] = (await readJ(path.join(C, '^TWII.json'))).candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };

  const files = (await fs.readdir(INST)).filter(f => /^\d{4}\.json$/.test(f));
  const all: Row[] = [];
  for (const f of files) {
    const code = f.replace('.json', '');
    const cdl = await readJ(path.join(C, `${code}.TW.json`)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 30) continue;
    const inst = await readJ(path.join(INST, f)), broker = await readJ(path.join(BROKER, f));
    const im = new Map<string, number>(); for (const d of (inst?.data || [])) im.set(d.date, d.total ?? 0);
    const bm = new Map<string, number>(); for (const d of (broker?.data || [])) bm.set(d.date, d.netDifference ?? 0);
    for (let t = 6; t + 1 + FWD < cs.length; t++) {
      let inst5 = 0, brk5 = 0, vol5 = 0, im_ok = true, bm_ok = true;
      for (let k = t - 4; k <= t; k++) {
        vol5 += cs[k].volume;
        if (im.has(cs[k].date)) inst5 += im.get(cs[k].date)!; else im_ok = false;
        if (bm.has(cs[k].date)) brk5 += bm.get(cs[k].date)!; else bm_ok = false;
      }
      if (vol5 <= 0) continue;
      const entry = cs[t + 1].open; if (!(entry > 0)) continue;
      const exit = cs[Math.min(t + 1 + FWD, cs.length - 1)].close;
      const ret = (exit / entry - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[Math.min(t + 1 + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
      all.push({
        brkConc: bm_ok ? brk5 * 1000 / vol5 * 100 : null,
        instConc: im_ok ? inst5 / vol5 * 100 : null,
        turnover: cs[t].close * (cs[t].volume || 0), iso: isoWeek(cs[t].date), excess: ret - mkt,
      });
    }
  }

  // 液態：每週成交額前500
  const byW = new Map<string, Row[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liquid: Row[] = [];
  for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liquid.push(r); }

  console.log('================================================');
  console.log(`避雷調校 — 液態股(每週成交額前500) ${liquid.length.toLocaleString()} 筆，持有${FWD}日超額對大盤`);
  console.log('================================================');
  stat('全體(液態基準)', liquid, () => true);
  console.log('\n【主力分點在倒貨(集中度負)門檻掃描】');
  for (const th of [0, -3, -5, -8, -12]) stat(`主力分點集中度 < ${th}%`, liquid, r => r.brkConc != null && r.brkConc < th);
  console.log('\n【法人在倒貨門檻】');
  for (const th of [0, -3, -5, -8]) stat(`法人集中度 < ${th}%`, liquid, r => r.instConc != null && r.instConc < th);
  console.log('\n【兩個都在倒(主力+法人同賣) — 雙重確認】');
  stat('主力<-3 且 法人<-3', liquid, r => r.brkConc != null && r.brkConc < -3 && r.instConc != null && r.instConc < -3);
  stat('主力<-5 且 法人<-5', liquid, r => r.brkConc != null && r.brkConc < -5 && r.instConc != null && r.instConc < -5);
  stat('主力<-8 且 法人<-5', liquid, r => r.brkConc != null && r.brkConc < -8 && r.instConc != null && r.instConc < -5);
  console.log('\n判讀：贏大盤越低=避得越準；要兼顧涵蓋筆數別太少。挑「贏大盤明顯<45%」的當避雷門檻。');
}
main().catch(e => { console.error(e); process.exit(1); });
