/**
 * 因子大搜捕 — 用全市場資料系統性找「真的能贏大盤」的因子
 *   每個因子把全部(股,日)觀測分 10 等分，看最高/最低那級之後20日「贏大盤(超額)」多少。
 *   不猜方法，讓資料自己講。進場隔日開盤、持有20日、超額對 ^TWII。
 *   嚴格紀律：全市場、大樣本、看超額>0 且贏大盤>52% 才算數。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const MARGIN = path.join(process.cwd(), 'data/chips/TW/margin');
const SBL = path.join(process.cwd(), 'data/chips/TW/sbl');
const DAY = path.join(process.cwd(), 'data/chips/TW/daytrade');
const FWD = 20;

interface OHLC { date: string; open: number; close: number; volume: number }
type Row = { f: Record<string, number>; excess: number };

async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }

function decile(rows: Row[], key: string) {
  const valid = rows.filter(r => r.f[key] != null && isFinite(r.f[key]));
  if (valid.length < 100) return null;
  valid.sort((a, b) => a.f[key]! - b.f[key]!);
  const q = Math.floor(valid.length / 10);
  const top = valid.slice(-q), bot = valid.slice(0, q);
  const ex = (s: Row[]) => s.reduce((x, r) => x + r.excess, 0) / s.length;
  const winM = (s: Row[]) => 100 * s.filter(r => r.excess > 0).length / s.length;
  return { n: valid.length, topEx: ex(top), topWin: winM(top), botEx: ex(bot), botWin: winM(bot) };
}

async function main() {
  const twii: OHLC[] = (await readJ(path.join(C, '^TWII.json'))).candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };

  const files = (await fs.readdir(INST)).filter(f => /^\d{4}\.json$/.test(f));
  const rows: Row[] = [];

  for (const f of files) {
    const code = f.replace('.json', '');
    const cdl = await readJ(path.join(C, `${code}.TW.json`));
    if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0);
    if (cs.length < 60) continue;
    const inst = await readJ(path.join(INST, f));
    const broker = await readJ(path.join(BROKER, f));
    const margin = await readJ(path.join(MARGIN, f));
    const sbl = await readJ(path.join(SBL, f));
    const day = await readJ(path.join(DAY, f));
    const im = new Map<string, number>(); for (const d of (inst?.data || [])) im.set(d.date, d.total ?? 0);
    const bm = new Map<string, number>(); for (const d of (broker?.data || [])) bm.set(d.date, d.netDifference ?? 0);
    const mg = new Map<string, number>(); for (const d of (margin?.data || [])) mg.set(d.date, d.marginBalance ?? 0);
    const sb = new Map<string, number>(); for (const d of (sbl?.data || [])) sb.set(d.date, d.lendingBalance ?? 0);
    const dt = new Map<string, number>(); for (const d of (day?.data || [])) dt.set(d.date, d.dayTradeLots ?? 0);

    for (let t = 25; t + FWD < cs.length; t++) {
      const date = cs[t].date;
      const f: Record<string, number> = {};
      // 價量
      f['動能5日'] = (cs[t].close / cs[t - 5].close - 1) * 100;
      f['動能20日'] = (cs[t].close / cs[t - 20].close - 1) * 100;
      let ma20 = 0; for (let k = t - 19; k <= t; k++) ma20 += cs[k].close; ma20 /= 20;
      f['MA20乖離'] = (cs[t].close / ma20 - 1) * 100;
      let v5 = 0, v20 = 0; for (let k = t - 4; k <= t; k++) v5 += cs[k].volume; for (let k = t - 19; k <= t; k++) v20 += cs[k].volume;
      f['量比'] = v20 > 0 ? (v5 / 5) / (v20 / 20) : 0;
      // 籌碼(用近5日和/量)
      let inst5 = 0, brk5 = 0, vol5 = 0, miss = false;
      for (let k = t - 4; k <= t; k++) { if (!im.has(cs[k].date)) { miss = true; break; } inst5 += im.get(cs[k].date)!; vol5 += cs[k].volume; }
      if (!miss && vol5 > 0) f['法人集中5'] = inst5 / vol5 * 100;
      let bmiss = false; for (let k = t - 4; k <= t; k++) { if (!bm.has(cs[k].date)) { bmiss = true; break; } brk5 += bm.get(cs[k].date)!; }
      if (!bmiss && vol5 > 0) f['主力分點集中5'] = brk5 * 1000 / vol5 * 100;
      // 融資5日變化%
      if (mg.has(date) && mg.has(cs[t - 5].date) && mg.get(cs[t - 5].date)! > 0) f['融資5日變化'] = (mg.get(date)! / mg.get(cs[t - 5].date)! - 1) * 100;
      // 借券5日變化
      if (sb.has(date) && sb.has(cs[t - 5].date) && sb.get(cs[t - 5].date)! > 0) f['借券5日變化'] = (sb.get(date)! / sb.get(cs[t - 5].date)! - 1) * 100;
      // 當沖比
      if (dt.has(date) && cs[t].volume > 0) f['當沖比'] = dt.get(date)! / cs[t].volume * 100;

      const entry = cs[t + 1].open; if (!(entry > 0)) continue;
      const exit = cs[Math.min(t + 1 + FWD, cs.length - 1)].close;
      const ret = (exit / entry - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[Math.min(t + 1 + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0 && twii[e].close > 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
      rows.push({ f, excess: ret - mkt });
    }
  }

  console.log('================================================');
  console.log(`因子大搜捕 — 全市場 ${rows.length.toLocaleString()} 筆，持有${FWD}日，超額對^TWII`);
  console.log('最高10%級 vs 最低10%級 的「之後20日超額」+ 贏大盤比例');
  console.log('================================================');
  const keys = ['動能5日', '動能20日', 'MA20乖離', '量比', '法人集中5', '主力分點集中5', '融資5日變化', '借券5日變化', '當沖比'];
  const results = keys.map(k => ({ k, d: decile(rows, k) })).filter(r => r.d);
  // 按 max(|topEx|,|botEx|) 排，找分得最開的
  results.sort((a, b) => Math.max(Math.abs(b.d!.topEx), Math.abs(b.d!.botEx)) - Math.max(Math.abs(a.d!.topEx), Math.abs(a.d!.botEx)));
  for (const { k, d } of results) {
    console.log(`\n${k}  (${d!.n.toLocaleString()}筆)`);
    console.log(`  最高10%級: 超額 ${d!.topEx >= 0 ? '+' : ''}${d!.topEx.toFixed(2)}%  贏大盤 ${d!.topWin.toFixed(0)}%`);
    console.log(`  最低10%級: 超額 ${d!.botEx >= 0 ? '+' : ''}${d!.botEx.toFixed(2)}%  贏大盤 ${d!.botWin.toFixed(0)}%`);
  }
  console.log('\n判讀：哪一級「超額明顯>0 且 贏大盤>52%」= 可能有料(買那級)；明顯<0 = 可拿來避開。');
}
main().catch(e => { console.error(e); process.exit(1); });
