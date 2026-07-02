/**
 * 粗版(徐黎芳) vs refined版(肌肉書僮) — 用同一份資料、不同時間窗對照。
 *   粗版    = 跌3% + 法人5日集中度>8%（依集中度高低）
 *   refined = 主力分點20日集中度「由負轉正」+1~5% + 5日<8(濾隔日沖) + 不爆量
 * 特別放「近7個月」模擬最初那個小窗口(看是否被小樣本灌水)。
 * 液態股(每週成交額前500)、隔日開盤進場、持有20日、超額對^TWII、集中度=Σ淨差/Σ量×100。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const FWD = 20;

interface OHLC { date: string; open: number; close: number; volume: number }
interface R {
  date: string; iso: string; turnover: number; excess: number;
  dip5: number; inst5: number | null; brk20: number | null; brk20p: number | null; brk5: number | null; volR: number;
}
async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }

function stat(label: string, rows: R[], pick: (r: R) => boolean) {
  const s = rows.filter(pick);
  if (s.length < 25) { console.log(`    ${label.padEnd(20)} ${s.length}筆(太少)`); return; }
  const ex = s.reduce((x, r) => x + r.excess, 0) / s.length;
  const win = 100 * s.filter(r => r.excess > 0).length / s.length;
  const flag = (ex > 0 && win >= 50) ? ' ★' : '';
  console.log(`    ${label.padEnd(20)} ${String(s.length).padStart(4)}筆 | 超額${ex >= 0 ? '+' : ''}${ex.toFixed(2)}% | 贏大盤${win.toFixed(0)}%${flag}`);
}

async function main() {
  const twii: OHLC[] = (await readJ(path.join(C, '^TWII.json'))).candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
  const files = (await fs.readdir(BROKER)).filter(f => /^\d{4}\.json$/.test(f));
  const all: R[] = [];
  for (const f of files) {
    const code = f.replace('.json', '');
    const cdl = await readJ(path.join(C, `${code}.TW.json`)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 50) continue;
    const [bk, ins] = await Promise.all([readJ(path.join(BROKER, f)), readJ(path.join(INST, f))]);
    const bm = new Map<string, number>(); for (const d of (bk?.data || [])) bm.set(d.date, d.netDifference ?? 0);
    const im = new Map<string, number>(); for (const d of (ins?.data || [])) im.set(d.date, d.total ?? 0);
    const conc = (mp: Map<string, number>, t: number, w: number): number | null => { let n = 0, v = 0; for (let k = t - w + 1; k <= t; k++) { if (!mp.has(cs[k].date)) return null; n += mp.get(cs[k].date)!; v += cs[k].volume; } return v > 0 ? n / v * 100 : null; };
    for (let t = 25; t + 1 + FWD < cs.length; t++) {
      const entry = cs[t + 1].open; if (!(entry > 0)) continue;
      const ret = (cs[Math.min(t + 1 + FWD, cs.length - 1)].close / entry - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[Math.min(t + 1 + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
      let v20 = 0; for (let k = t - 19; k <= t; k++) v20 += cs[k].volume;
      all.push({
        date: cs[t].date, iso: isoWeek(cs[t].date), turnover: cs[t].close * (cs[t].volume || 0), excess: ret - mkt,
        dip5: (cs[t].close / cs[t - 5].close - 1) * 100, inst5: conc(im, t, 5),
        brk20: conc(bm, t, 20), brk20p: conc(bm, t - 5, 20), brk5: conc(bm, t, 5),
        volR: v20 > 0 ? cs[t].volume / (v20 / 20) : 0,
      });
    }
  }
  const byW = new Map<string, R[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: R[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }

  const crude = (r: R) => r.dip5 < -3 && r.inst5 != null && r.inst5 > 8;
  const refined = (r: R) => r.brk20 != null && r.brk20p != null && r.brk20 > 0 && r.brk20p <= 0 && r.brk20 >= 1 && r.brk20 <= 5 && r.brk5 != null && r.brk5 < 8 && r.volR < 1.8;

  const windows: [string, string][] = [
    ['全期 (2年)', '2024-06-12'],
    ['近1年', '2025-06-12'],
    ['近7個月 (模擬最初好窗口)', '2025-11-12'],
  ];
  console.log('================================================');
  console.log('粗版(徐黎芳/法人) vs refined版(肌肉書僮/主力分點) — 同資料不同時間窗');
  console.log('================================================');
  for (const [name, from] of windows) {
    const w = liq.filter(r => r.date >= from);
    console.log(`\n【${name}】 ${w.length.toLocaleString()} 筆`);
    stat('基準(全液態)', w, () => true);
    stat('粗版 徐黎芳', w, crude);
    stat('refined 肌肉書僮', w, refined);
  }
  console.log('\n判讀:★=超額>0且贏大盤≥50%。看 refined 是否每個窗都比粗版好;以及短窗口是否灌水。');
}
main().catch(e => { console.error(e); process.exit(1); });
