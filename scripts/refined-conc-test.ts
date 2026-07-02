/**
 * 肌肉書僮 refined 版回測 — 不看集中度高低，看「20日由負轉正 + 濾隔日沖 + 流通量」
 *   主力分點 20日集中度由負轉正 + 1-5%區間 + 5日不過高(濾隔日沖) + 不爆量，液態股
 *   進場隔日開盤、持有20日、超額對^TWII。逐步疊看哪條加分。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const DAY = path.join(process.cwd(), 'data/chips/TW/daytrade');
const FWD = 20;

interface OHLC { date: string; open: number; close: number; volume: number }
interface Row {
  conc20: number; conc20prev: number; conc5: number; volRatio: number; dayRatio: number | null;
  turnover: number; iso: string; excess: number;
}
async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }

function stat(label: string, rows: Row[], pick: (r: Row) => boolean) {
  const s = rows.filter(pick);
  if (s.length < 40) { console.log(`  ${label.padEnd(34)} ${s.length}筆(太少)`); return; }
  const ex = s.reduce((x, r) => x + r.excess, 0) / s.length;
  const win = 100 * s.filter(r => r.excess > 0).length / s.length;
  console.log(`  ${label.padEnd(34)} ${String(s.length).padStart(6)}筆 | 超額${ex >= 0 ? '+' : ''}${ex.toFixed(2)}% | 贏大盤${win.toFixed(0)}%`);
}

async function main() {
  const twii: OHLC[] = (await readJ(path.join(C, '^TWII.json'))).candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };

  const files = (await fs.readdir(BROKER)).filter(f => /^\d{4}\.json$/.test(f));
  const all: Row[] = [];
  for (const f of files) {
    const code = f.replace('.json', '');
    const cdl = await readJ(path.join(C, `${code}.TW.json`)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 50) continue;
    const broker = await readJ(path.join(BROKER, f)); const day = await readJ(path.join(DAY, `${code}.json`));
    const bm = new Map<string, number>(); for (const d of (broker?.data || [])) bm.set(d.date, d.netDifference ?? 0);
    const dt = new Map<string, number>(); for (const d of (day?.data || [])) dt.set(d.date, d.dayTradeLots ?? 0);

    const conc = (t: number, w: number): number | null => {
      let n = 0, v = 0; for (let k = t - w + 1; k <= t; k++) { if (!bm.has(cs[k].date)) return null; n += bm.get(cs[k].date)!; v += cs[k].volume; }
      return v > 0 ? n / v * 100 : null; // 兩者都張，不可再×1000
    };
    for (let t = 25; t + 1 + FWD < cs.length; t++) {
      const c20 = conc(t, 20), c20p = conc(t - 5, 20), c5 = conc(t, 5);
      if (c20 == null || c20p == null || c5 == null) continue;
      let v20 = 0; for (let k = t - 19; k <= t; k++) v20 += cs[k].volume;
      const volRatio = v20 > 0 ? cs[t].volume / (v20 / 20) : 0;
      const dayRatio = dt.has(cs[t].date) && cs[t].volume > 0 ? dt.get(cs[t].date)! / cs[t].volume * 100 : null;
      const entry = cs[t + 1].open; if (!(entry > 0)) continue;
      const exit = cs[Math.min(t + 1 + FWD, cs.length - 1)].close;
      const ret = (exit / entry - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[Math.min(t + 1 + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
      all.push({ conc20: c20, conc20prev: c20p, conc5: c5, volRatio, dayRatio, turnover: cs[t].close * (cs[t].volume || 0), iso: isoWeek(cs[t].date), excess: ret - mkt });
    }
  }
  // 液態 top500/週
  const byW = new Map<string, Row[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: Row[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }

  console.log('================================================');
  console.log(`refined 籌碼集中度回測(肌肉書僮版) — 液態股 ${liq.length.toLocaleString()} 筆，持有${FWD}日超額`);
  console.log('================================================');
  stat('全體(液態基準)', liq, () => true);
  console.log('\n【逐步疊】');
  stat('① 20日集中度>0', liq, r => r.conc20 > 0);
  stat('② 20日「由負轉正」(5日前<0,今>0)', liq, r => r.conc20 > 0 && r.conc20prev <= 0);
  stat('③ ②+ 20日在1~5%區間', liq, r => r.conc20 > 0 && r.conc20prev <= 0 && r.conc20 >= 1 && r.conc20 <= 5);
  stat('④ ③+ 5日不過高<8%(濾隔日沖)', liq, r => r.conc20 > 0 && r.conc20prev <= 0 && r.conc20 >= 1 && r.conc20 <= 5 && r.conc5 < 8);
  stat('⑤ ④+ 不爆量(<1.8倍均量)', liq, r => r.conc20 > 0 && r.conc20prev <= 0 && r.conc20 >= 1 && r.conc20 <= 5 && r.conc5 < 8 && r.volRatio < 1.8);
  console.log('\n【加當沖比濾隔日沖(僅近1年有資料)】');
  stat('⑤ + 當沖比<20%', liq, r => r.conc20 > 0 && r.conc20prev <= 0 && r.conc20 >= 1 && r.conc20 <= 5 && r.conc5 < 8 && r.volRatio < 1.8 && r.dayRatio != null && r.dayRatio < 20);
  console.log('\n對照組(我們之前測的「高集中度」):');
  stat('20日集中度 top(>8%)', liq, r => r.conc20 > 8);
  console.log('\n判讀：refined 版若超額>0 且贏大盤>52%,就是「看轉向+濾污染」真的比「看高低」強。');
}
main().catch(e => { console.error(e); process.exit(1); });
