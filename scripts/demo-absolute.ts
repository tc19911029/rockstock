/**
 * 「漲了≠策略有用」示範 — 策略選出的股票 vs 全部股票 vs 大盤，比「絕對漲幅 + 漲的比例」
 * 過去1年液態股、持有20日。重點：在多頭市場,選出來的會漲,但全部都漲、大盤也漲。
 */
import { promises as fs } from 'fs';
import path from 'path';
const C = path.join(process.cwd(), 'data/candles/TW');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const FROM = '2025-06-12', FWD = 20;
interface OHLC { date: string; open: number; close: number; volume: number }
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }
interface R { dip5: number; brk5: number | null; inst5: number | null; ret: number; mkt: number; turnover: number; iso: string }

function show(label: string, rows: R[]) {
  if (rows.length < 30) { console.log(`  ${label.padEnd(28)} ${rows.length}筆(太少)`); return; }
  const aRet = rows.reduce((s, r) => s + r.ret, 0) / rows.length;
  const aMkt = rows.reduce((s, r) => s + r.mkt, 0) / rows.length;
  const upRate = 100 * rows.filter(r => r.ret > 0).length / rows.length;
  const big = 100 * rows.filter(r => r.ret > 10).length / rows.length;
  console.log(`  ${label.padEnd(28)} ${String(rows.length).padStart(5)}筆 | 平均漲 ${aRet >= 0 ? '+' : ''}${aRet.toFixed(1)}% | 漲的比例 ${upRate.toFixed(0)}% | 漲>10% 佔 ${big.toFixed(0)}% | (同期大盤 ${aMkt >= 0 ? '+' : ''}${aMkt.toFixed(1)}%)`);
}

async function main() {
  const twii: OHLC[] = (await readJ(path.join(C, '^TWII.json'))).candles;
  const td = twii.map(c => c.date); const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
  const files = (await fs.readdir(BROKER)).filter(f => /^\d{4}\.json$/.test(f));
  const all: R[] = [];
  for (const f of files) {
    const code = f.replace('.json', ''); const cdl = await readJ(path.join(C, `${code}.TW.json`)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 50) continue;
    const [bk, ins] = await Promise.all([readJ(path.join(BROKER, f)), readJ(path.join(INST, f))]);
    const bm = new Map<string, number>(); for (const d of (bk?.data || [])) bm.set(d.date, d.netDifference ?? 0);
    const im = new Map<string, number>(); for (const d of (ins?.data || [])) im.set(d.date, d.total ?? 0);
    const conc = (mp: Map<string, number>, t: number, w: number): number | null => { let n = 0, v = 0; for (let k = t - w + 1; k <= t; k++) { if (!mp.has(cs[k].date)) return null; n += mp.get(cs[k].date)!; v += cs[k].volume; } return v > 0 ? n / v * 100 : null; };
    for (let t = 25; t + 1 + FWD < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      const ret = (cs[Math.min(t + 1 + FWD, cs.length - 1)].close / cs[t + 1].open - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[Math.min(t + 1 + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
      all.push({ dip5: (cs[t].close / cs[t - 5].close - 1) * 100, brk5: conc(bm, t, 5), inst5: conc(im, t, 5), ret, mkt, turnover: cs[t].close * (cs[t].volume || 0), iso: isoWeek(cs[t].date) });
    }
  }
  const byW = new Map<string, R[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: R[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  console.log('================================================');
  console.log(`「漲了≠有用」— 過去1年液態股,持有20日的絕對漲幅`);
  console.log('================================================');
  show('🎯 策略:跌+法人集中>8%', liq.filter(r => r.dip5 < -3 && r.inst5 != null && r.inst5 > 8));
  show('🎲 隨便買(全部液態股)', liq);
  show('🎲 隨便買 + 在跌的', liq.filter(r => r.dip5 < -3));
  console.log('\n看「漲的比例」「漲>10%佔比」「同期大盤」三欄 — 策略跟隨便買幾乎一樣 = 漲是市場給的,不是策略選的。');
}
main().catch(e => { console.error(e); process.exit(1); });
