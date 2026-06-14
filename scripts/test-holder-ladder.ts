/**
 * 大戶階梯回測 — 照使用者的想法測：「大戶不是看高低,是看整條階梯有沒有往上爬、持續增加」
 *   TDCC 週度分級(100/200/400/1000張持股% + 股東人數)。
 *   訊號 = 各級距「N 週變化」(持續增加),以及「人數減少+大戶增加」的籌碼集中。
 *   進場:TDCC 週資料公布後(加 lag 防前視) → 隔交易日開盤,持有20交易日,超額對^TWII。
 *   液態股(每週成交額前500)。每個因子取「最強10%」對照全體基準 + train/test 各半驗證。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const TDCC = path.join(process.cwd(), 'data/chips/TW/tdcc');
const FWD = 20;          // 持有20交易日
const LAG_DAYS = 4;      // TDCC 週五資料約下週才公布,進場日往後推≥4日曆天防前視

interface OHLC { date: string; open: number; close: number; volume: number }
interface Wk { date: string; h100: number; h400: number; h1000: number; cnt: number }
interface Row {
  d1000_4: number | null; d1000_8: number | null; d400_4: number | null; d100_4: number | null;
  dCnt_4: number | null; ladderUp: boolean; concentrate: boolean; lvl1000: number;
  turnover: number; iso: string; excess: number; date: string;
}
async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }
function addDays(d: string, n: number) { const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); }

function summary(label: string, rows: Row[], pick: (r: Row) => boolean, frac?: { key: (r: Row) => number | null; pool: Row[]; hi?: boolean }) {
  let s: Row[];
  if (frac) {
    const v = frac.pool.filter(r => frac.key(r) != null && pick(r));
    v.sort((a, b) => (frac.key(b)! - frac.key(a)!) * (frac.hi === false ? -1 : 1));
    s = v.slice(0, Math.floor(v.length * 0.1));
  } else s = rows.filter(pick);
  if (s.length < 40) { console.log(`  ${label.padEnd(34)} ${s.length}筆(太少)`); return; }
  const ex = s.reduce((x, r) => x + r.excess, 0) / s.length;
  const win = 100 * s.filter(r => r.excess > 0).length / s.length;
  const flag = (ex > 0.5 && win >= 52) ? ' ★' : '';
  console.log(`  ${label.padEnd(34)} ${String(s.length).padStart(5)}筆 | 超額${ex >= 0 ? '+' : ''}${ex.toFixed(2)}% | 贏大盤${win.toFixed(0)}%${flag}`);
}

async function main() {
  const twii: OHLC[] = (await readJ(path.join(C, '^TWII.json'))).candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };

  const files = (await fs.readdir(TDCC)).filter(f => /^\d{4}\.json$/.test(f)); // 4碼台股
  const all: Row[] = [];
  for (const f of files) {
    const code = f.replace('.json', '');
    const cdl = await readJ(path.join(C, `${code}.TW.json`)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 50) continue;
    const cDate = cs.map(c => c.date);
    const csAt = (d: string) => { let lo = 0, hi = cDate.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (cDate[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
    const tj = await readJ(path.join(TDCC, f)); const wk: Wk[] = (tj?.data || [])
      .map((d: any) => ({ date: d.date, h100: d.holder100Pct, h400: d.holder400Pct, h1000: d.holder1000Pct, cnt: d.holderCount }))
      .filter((w: Wk) => w.h1000 != null && w.cnt != null)
      .sort((a: Wk, b: Wk) => a.date < b.date ? -1 : 1);
    if (wk.length < 10) continue;

    for (let w = 8; w < wk.length; w++) {
      const entryDate = addDays(wk[w].date, LAG_DAYS);          // 公布 lag 後
      let t = csAt(entryDate); if (t < 0) continue;
      if (cDate[t] < entryDate) t += 1;                          // 第一根 >= entryDate
      if (t < 0 || t + FWD >= cs.length) continue;
      const entry = cs[t].open; if (!(entry > 0)) continue;
      const exit = cs[Math.min(t + FWD, cs.length - 1)].close;
      const ret = (exit / entry - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t].date), x = twAt(cs[Math.min(t + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;

      const d1000_4 = wk[w].h1000 - wk[w - 4].h1000;
      const d1000_8 = wk[w].h1000 - wk[w - 8].h1000;
      const d400_4 = wk[w].h400 - wk[w - 4].h400;
      const d100_4 = wk[w].h100 - wk[w - 4].h100;
      const dCnt_4 = (wk[w - 4].cnt > 0) ? (wk[w].cnt / wk[w - 4].cnt - 1) * 100 : null;
      // 階梯往上爬 = 大戶各級距4週都增加(階梯整體上移)
      const ladderUp = d1000_4 > 0 && d400_4 > 0 && d100_4 > 0;
      // 籌碼集中 = 千張大戶增加 且 總人數減少(小戶把籌碼交出去)
      const concentrate = d1000_4 > 0 && dCnt_4 != null && dCnt_4 < 0;

      all.push({ d1000_4, d1000_8, d400_4, d100_4, dCnt_4, ladderUp, concentrate, lvl1000: wk[w].h1000, turnover: cs[t].close * (cs[t].volume || 0), iso: isoWeek(cs[t].date), excess: ret - mkt, date: cs[t].date });
    }
  }

  // 液態 top500/週
  const byW = new Map<string, Row[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: Row[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  const mid = liq[Math.floor(liq.length / 2)].date;
  const train = liq.filter(r => r.date < mid), test = liq.filter(r => r.date >= mid);

  const run = (label: string, pool: Row[]) => {
    console.log(`\n========== ${label} (${pool.length.toLocaleString()}筆, ${pool[0].date}~${pool[pool.length - 1].date}) ==========`);
    summary('全體基準(液態)', pool, () => true);
    console.log('  --- 你的想法:大戶持續增加(取最強10%) ---');
    summary('千張大戶% 4週增加 最多10%', [], () => true, { key: r => r.d1000_4, pool });
    summary('千張大戶% 8週增加 最多10%', [], () => true, { key: r => r.d1000_8, pool });
    summary('400張大戶% 4週增加 最多10%', [], () => true, { key: r => r.d400_4, pool });
    console.log('  --- 階梯整體上移 / 籌碼集中 ---');
    summary('階梯全面增加(1000+400+100都漲)', pool, r => r.ladderUp);
    summary('千張增加+人數減少(籌碼集中)', pool, r => r.concentrate);
    summary('人數4週減最多10%(小戶離場)', [], () => true, { key: r => r.dCnt_4, pool, hi: false });
    console.log('  --- 對照組:單看高低(之前測過沒用的) ---');
    summary('千張大戶% 水位最高10%', [], () => true, { key: r => r.lvl1000, pool });
  };
  run('全期', liq);
  run('前半(train)', train);
  run('後半(test)', test);
  console.log('\n判讀:有★=超額>0.5%且贏大盤≥52%。要 train 跟 test 都★才算真的;只有一邊★=過擬合/運氣。');
}
main().catch(e => { console.error(e); process.exit(1); });
