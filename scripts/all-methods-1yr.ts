/**
 * 全方法對照 — 過去 1 年(2025-06~)液態股,所有討論過的方法各跑一次,並排比較
 * 進場隔日開盤、持有20日、超額對^TWII。集中度=Σ淨差(張)/Σ量(張)×100(無×1000)。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const MARGIN = path.join(process.cwd(), 'data/chips/TW/margin');
const SBL = path.join(process.cwd(), 'data/chips/TW/sbl');
const DAYT = path.join(process.cwd(), 'data/chips/TW/daytrade');
const FROM = '2025-06-12';
const FWD = 20;

interface OHLC { date: string; open: number; close: number; volume: number }
interface R {
  brk5: number | null; brk20: number | null; brk20p: number | null;
  inst5: number | null; mom20: number; dev20: number; volR: number;
  dip5: number; margin5: number | null; sbl5: number | null; dayR: number | null;
  turnover: number; iso: string; excess: number;
}
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }

function stat(label: string, rows: R[], pick: (r: R) => boolean) {
  const s = rows.filter(pick);
  if (s.length < 30) { console.log(`  ${label.padEnd(32)} ${s.length}筆(太少)`); return; }
  const ex = s.reduce((x, r) => x + r.excess, 0) / s.length;
  const win = 100 * s.filter(r => r.excess > 0).length / s.length;
  const flag = (ex > 0 && win >= 52) ? ' ★' : '';
  console.log(`  ${label.padEnd(32)} ${String(s.length).padStart(5)}筆 | 超額${ex >= 0 ? '+' : ''}${ex.toFixed(2)}% | 贏大盤${win.toFixed(0)}%${flag}`);
}
function topFrac(rows: R[], key: (r: R) => number | null, frac: number, hi = true) {
  const v = rows.filter(r => key(r) != null) as R[];
  v.sort((a, b) => (key(b)! - key(a)!) * (hi ? 1 : -1));
  return new Set(v.slice(0, Math.floor(v.length * frac)));
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
    const [bk, ins, mg, sb, dy] = await Promise.all([readJ(path.join(BROKER, f)), readJ(path.join(INST, f)), readJ(path.join(MARGIN, f)), readJ(path.join(SBL, f)), readJ(path.join(DAYT, f))]);
    const bm = new Map<string, number>(); for (const d of (bk?.data || [])) bm.set(d.date, d.netDifference ?? 0);
    const im = new Map<string, number>(); for (const d of (ins?.data || [])) im.set(d.date, d.total ?? 0);
    const mgm = new Map<string, number>(); for (const d of (mg?.data || [])) mgm.set(d.date, d.marginBalance ?? 0);
    const sbm = new Map<string, number>(); for (const d of (sb?.data || [])) sbm.set(d.date, d.lendingBalance ?? 0);
    const dym = new Map<string, number>(); for (const d of (dy?.data || [])) dym.set(d.date, d.dayTradeLots ?? 0);
    const conc = (mp: Map<string, number>, t: number, w: number, isInst = false): number | null => {
      let n = 0, v = 0; for (let k = t - w + 1; k <= t; k++) { if (!mp.has(cs[k].date)) return null; n += mp.get(cs[k].date)!; v += cs[k].volume; }
      return v > 0 ? (isInst ? n : n) / v * 100 : null;
    };
    for (let t = 25; t + 1 + FWD < cs.length; t++) {
      if (cs[t].date < FROM) continue;
      let v20 = 0; for (let k = t - 19; k <= t; k++) v20 += cs[k].volume;
      let ma20 = 0; for (let k = t - 19; k <= t; k++) ma20 += cs[k].close; ma20 /= 20;
      const entry = cs[t + 1].open; if (!(entry > 0)) continue;
      const exit = cs[Math.min(t + 1 + FWD, cs.length - 1)].close;
      const ret = (exit / entry - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[Math.min(t + 1 + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
      all.push({
        brk5: conc(bm, t, 5), brk20: conc(bm, t, 20), brk20p: conc(bm, t - 5, 20),
        inst5: conc(im, t, 5, true), mom20: (cs[t].close / cs[t - 20].close - 1) * 100, dev20: (cs[t].close / ma20 - 1) * 100,
        volR: v20 > 0 ? cs[t].volume / (v20 / 20) : 0, dip5: (cs[t].close / cs[t - 5].close - 1) * 100,
        margin5: (mgm.has(cs[t].date) && mgm.has(cs[t - 5].date) && mgm.get(cs[t - 5].date)! > 0) ? (mgm.get(cs[t].date)! / mgm.get(cs[t - 5].date)! - 1) * 100 : null,
        sbl5: (sbm.has(cs[t].date) && sbm.has(cs[t - 5].date) && sbm.get(cs[t - 5].date)! > 0) ? (sbm.get(cs[t].date)! / sbm.get(cs[t - 5].date)! - 1) * 100 : null,
        dayR: (dym.has(cs[t].date) && cs[t].volume > 0) ? dym.get(cs[t].date)! / cs[t].volume * 100 : null,
        turnover: cs[t].close * (cs[t].volume || 0), iso: isoWeek(cs[t].date), excess: ret - mkt,
      });
    }
  }
  const byW = new Map<string, R[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: R[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }

  const brkHi = topFrac(liq, r => r.brk5, 0.1);
  const momHi = topFrac(liq, r => r.mom20, 0.1);
  const devHi = topFrac(liq, r => r.dev20, 0.1);

  console.log('================================================');
  console.log(`全方法對照 — 過去1年(${FROM}~) 液態股 ${liq.length.toLocaleString()} 筆,持有${FWD}日超額  (★=超額>0且贏大盤≥52%)`);
  console.log('================================================');
  stat('全體基準', liq, () => true);
  console.log('\n[徐黎芳:跌+主力買]');
  stat('跌3% + 主力集中度top10%', liq, r => r.dip5 < -3 && brkHi.has(r));
  stat('跌3% + 法人集中度>8%', liq, r => r.dip5 < -3 && r.inst5 != null && r.inst5 > 8);
  console.log('\n[肌肉書僮:refined]');
  stat('20日由負轉正+1~5%+5日<8+不爆量', liq, r => r.brk20 != null && r.brk20p != null && r.brk20 > 0 && r.brk20p <= 0 && r.brk20 >= 1 && r.brk20 <= 5 && r.brk5 != null && r.brk5 < 8 && r.volR < 1.8);
  console.log('\n[動能/技術]');
  stat('動能20日 top10%', liq, r => momHi.has(r));
  stat('MA20乖離 top10%', liq, r => devHi.has(r));
  stat('動能top10 + 主力集中正', liq, r => momHi.has(r) && r.brk20 != null && r.brk20 > 0);
  console.log('\n[避雷:這些是「別買」]');
  stat('主力+法人同倒(<-5%)', liq, r => r.brk5 != null && r.brk5 < -5 && r.inst5 != null && r.inst5 < -5);
  console.log('\n[融資/借券/當沖]');
  stat('融資5日退(<0)', liq, r => r.margin5 != null && r.margin5 < 0);
  stat('借券5日暴增(>20%)', liq, r => r.sbl5 != null && r.sbl5 > 20);
  stat('當沖比低<5%(冷門避開)', liq, r => r.dayR != null && r.dayR < 5);
  console.log('\n判讀：有★的=這一年相對贏大盤;但1年樣本短,要跟2年結果一起看才算數。');
}
main().catch(e => { console.error(e); process.exit(1); });
