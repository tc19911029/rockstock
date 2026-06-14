/**
 * 「最好的規律」驗證 — 由前面 234 組合推理出的 a-priori 規則，前一年找後一年驗。
 * 規律：買「股價在跌/長黑 + 法人逆勢買」，剔除「大戶持股水位已超高」。
 * 不是亂湊（先定義邏輯再測），逐步疊看每一步加分多少。
 * 全市場液態股、隔日開盤進場、持有20日。報「超額對大盤」+「個股自己:漲的比例/平均漲」。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const TDCC = path.join(process.cwd(), 'data/chips/TW/tdcc');
const FROM = '2024-07-20', FWD = 20;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Row {
  date: string; iso: string; turnover: number; excess: number; ret: number; mkt: number;
  inst5: number | null; dip5: number; todayChg: number; volSpike: boolean; holderLvl: number | null;
}
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }

function show(label: string, rows: Row[]) {
  if (rows.length < 25) { console.log(`  ${label.padEnd(30)} ${rows.length}筆(太少)`); return; }
  const ex = rows.reduce((s, r) => s + r.excess, 0) / rows.length;
  const win = 100 * rows.filter(r => r.excess > 0).length / rows.length;
  const aRet = rows.reduce((s, r) => s + r.ret, 0) / rows.length;
  const up = 100 * rows.filter(r => r.ret > 0).length / rows.length;
  const aMkt = rows.reduce((s, r) => s + r.mkt, 0) / rows.length;
  console.log(`  ${label.padEnd(30)} ${String(rows.length).padStart(5)}筆 | 超額${ex >= 0 ? '+' : ''}${ex.toFixed(2)}% 贏大盤${win.toFixed(0)}% | (自己:平均${aRet >= 0 ? '+' : ''}${aRet.toFixed(1)}% 漲${up.toFixed(0)}%, 同期大盤${aMkt >= 0 ? '+' : ''}${aMkt.toFixed(1)}%)`);
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
    const [ins, tj] = await Promise.all([readJ(path.join(INST, f)), readJ(path.join(TDCC, f))]);
    const im = new Map<string, number>(); for (const d of (ins?.data || [])) im.set(d.date, d.total ?? 0);
    const tdccRows = (tj?.data || []).filter((r: any) => r).sort((a: any, b: any) => a.date < b.date ? -1 : 1);
    const holderLvlAt = (t: number): number | null => {
      const px = cs[t].close; const key = px >= 250 ? 'holder100Pct' : px >= 50 ? 'holder400Pct' : 'holder1000Pct';
      for (let i = tdccRows.length - 1; i >= 0; i--) if (tdccRows[i].date <= cs[t].date) return tdccRows[i][key] ?? null;
      return null;
    };
    for (let t = 25; t + 1 + FWD < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      const ret = (cs[Math.min(t + 1 + FWD, cs.length - 1)].close / cs[t + 1].open - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[Math.min(t + 1 + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
      let v20 = 0; for (let kk = t - 19; kk <= t; kk++) v20 += cs[kk].volume;
      const inst5 = (() => { let n = 0; for (let kk = t - 4; kk <= t; kk++) { if (!im.has(cs[kk].date)) return null; n += im.get(cs[kk].date)!; } return n; })();
      all.push({
        date: cs[t].date, iso: isoWeek(cs[t].date), turnover: cs[t].close * (cs[t].volume || 0),
        excess: ret - mkt, ret, mkt, inst5, dip5: (cs[t].close / cs[t - 5].close - 1) * 100,
        todayChg: cs[t].open > 0 ? (cs[t].close / cs[t].open - 1) * 100 : 0,
        volSpike: v20 > 0 ? cs[t].volume > 2 * (v20 / 20) : false, holderLvl: holderLvlAt(t),
      });
    }
  }
  const byW = new Map<string, Row[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: Row[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  const mid = liq[Math.floor(liq.length / 2)].date;
  const hl = liq.filter(r => r.holderLvl != null).sort((a, b) => (b.holderLvl as number) - (a.holderLvl as number));
  const hiHolder = new Set(hl.slice(0, Math.floor(hl.length * 0.1)));

  const weak = (r: Row) => r.dip5 < -3 || r.todayChg < -3;           // 股價在跌 或 長黑
  const instBuy = (r: Row) => r.inst5 != null && r.inst5 > 0;        // 法人逆勢接
  const notCrowded = (r: Row) => !hiHolder.has(r);                   // 避開大戶持股超高

  const run = (name: string, pool: Row[]) => {
    console.log(`\n===== ${name}（${pool.length}筆）=====`);
    show('全液態基準', pool);
    show('① 法人逆勢買', pool.filter(instBuy));
    show('② 下跌/長黑 + 法人買', pool.filter(r => weak(r) && instBuy(r)));
    show('③ ② + 剔除大戶持股超高★', pool.filter(r => weak(r) && instBuy(r) && notCrowded(r)));
  };
  console.log('================================================');
  console.log('「最好的規律」驗證 — 下跌/長黑 + 法人逆勢買，剔除大戶持股超高');
  console.log('================================================');
  run('前一年 train', liq.filter(r => r.date < mid));
  run('後一年 test', liq.filter(r => r.date >= mid));
  console.log('\n判讀：③ 要 train+test 都「超額正、贏大盤≥50%」才算真規律；「自己漲的比例」要明顯>基準才算選得準。');
}
main().catch(e => { console.error(e); process.exit(1); });
