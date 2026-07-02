/**
 * 贏家解剖 — 把「之後20日漲最多的10%」(贏家) vs「跌最多的10%」(輸家) 抓出來，
 * 比較它們「進場時」各因子的差別。贏家>>輸家的因子 = 可能是真訊號；差不多 = 沒用。
 * 液態股、2年、超額對^TWII。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const MARGIN = path.join(process.cwd(), 'data/chips/TW/margin');
const SBL = path.join(process.cwd(), 'data/chips/TW/sbl');
const DAYT = path.join(process.cwd(), 'data/chips/TW/daytrade');
const FWD = 20;

interface OHLC { date: string; open: number; close: number; volume: number }
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function main() {
  const files = (await fs.readdir(BROKER)).filter(f => /^\d{4}\.json$/.test(f));
  type Row = { f: Record<string, number | null>; ret: number; turnover: number; iso: string };
  const all: Row[] = [];
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
    const conc = (mp: Map<string, number>, t: number, w: number): number | null => { let n = 0, v = 0; for (let k = t - w + 1; k <= t; k++) { if (!mp.has(cs[k].date)) return null; n += mp.get(cs[k].date)!; v += cs[k].volume; } return v > 0 ? n / v * 100 : null; };
    for (let t = 25; t + 1 + FWD < cs.length; t++) {
      let v20 = 0, ma20 = 0; for (let k = t - 19; k <= t; k++) { v20 += cs[k].volume; ma20 += cs[k].close; } ma20 /= 20;
      const ret = (cs[Math.min(t + 1 + FWD, cs.length - 1)].close / cs[t + 1].open - 1) * 100;
      if (!(cs[t + 1].open > 0) || Math.abs(ret) > 80) continue;
      all.push({
        f: {
          '主力5日集中': conc(bm, t, 5), '主力20日集中': conc(bm, t, 20), '法人5日集中': conc(im, t, 5),
          '動能5日': (cs[t].close / cs[t - 5].close - 1) * 100, '動能20日': (cs[t].close / cs[t - 20].close - 1) * 100,
          'MA20乖離': (cs[t].close / ma20 - 1) * 100, '量比': v20 > 0 ? cs[t].volume / (v20 / 20) : 0,
          '股價': cs[t].close,
          '融資5日%': (mgm.has(cs[t].date) && mgm.has(cs[t - 5].date) && mgm.get(cs[t - 5].date)! > 0) ? (mgm.get(cs[t].date)! / mgm.get(cs[t - 5].date)! - 1) * 100 : null,
          '當沖比': (dym.has(cs[t].date) && cs[t].volume > 0) ? dym.get(cs[t].date)! / cs[t].volume * 100 : null,
        },
        ret, turnover: cs[t].close * (cs[t].volume || 0), iso: isoWeek(cs[t].date),
      });
    }
  }
  // 液態
  const byW = new Map<string, Row[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: Row[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }

  liq.sort((a, b) => b.ret - a.ret);
  const q = Math.floor(liq.length / 10);
  const winners = liq.slice(0, q), losers = liq.slice(-q);
  console.log('================================================');
  console.log(`贏家解剖 — 液態股 ${liq.length.toLocaleString()} 筆，持有${FWD}日`);
  console.log(`贏家=漲最多10%(${winners.length}筆,平均${(winners.reduce((s, r) => s + r.ret, 0) / winners.length).toFixed(0)}%) vs 輸家=跌最多10%(平均${(losers.reduce((s, r) => s + r.ret, 0) / losers.length).toFixed(0)}%)`);
  console.log('================================================');
  console.log('因子                 贏家中位  輸家中位  差距(贏-輸)');
  const keys = Object.keys(liq[0].f);
  const rows = keys.map(k => {
    const w = winners.map(r => r.f[k]).filter(x => x != null) as number[];
    const l = losers.map(r => r.f[k]).filter(x => x != null) as number[];
    if (w.length < 50 || l.length < 50) return null;
    const wm = med(w), lm = med(l);
    return { k, wm, lm, diff: wm - lm };
  }).filter(Boolean) as { k: string; wm: number; lm: number; diff: number }[];
  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  for (const r of rows) {
    console.log(`  ${r.k.padEnd(16)} ${r.wm.toFixed(2).padStart(9)} ${r.lm.toFixed(2).padStart(9)} ${(r.diff >= 0 ? '+' : '') + r.diff.toFixed(2).padStart(8)}`);
  }
  console.log('\n判讀：差距越大的因子,越能分辨贏家/輸家。差距接近0=這因子對選贏家沒用。');
}
main().catch(e => { console.error(e); process.exit(1); });
