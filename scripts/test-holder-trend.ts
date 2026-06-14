/**
 * 大戶「趨勢」回測 — 照使用者想法:不看單週跳動,看「持續、慢慢爬的趨勢」。
 *   千張大戶%(holder1000Pct) 過去12週是不是「穩穩往上」。
 *   測「注意/觀察」用途 → 看之後 20日 + 60日(約3個月)。
 *   進場:訊號週公布後 lag → 隔交易日開盤;液態股(每週成交量前500);train/test各半。
 *   同時報「跟大盤比(超額)」+「個股自己(絕對上漲比例)」。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const TDCC = path.join(process.cwd(), 'data/chips/TW/tdcc');
const LAG = 4;

interface OHLC { date: string; open: number; close: number; volume: number }
interface Wk { date: string; h: number }
interface Row {
  steadyUp: boolean; net12: number; slopePos: boolean; consecUp: number; steadyDown: boolean;
  turnover: number; iso: string; date: string;
  ex20: number; up20: number; ex60: number | null; up60: number | null;
}
async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }
function addDays(d: string, n: number) { const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); }

function show(label: string, rows: Row[], pick: (r: Row) => boolean) {
  const s = rows.filter(pick);
  if (s.length < 40) { console.log(`  ${label.padEnd(30)} ${s.length}筆(太少)`); return; }
  const ex20 = s.reduce((x, r) => x + r.ex20, 0) / s.length;
  const win20 = 100 * s.filter(r => r.ex20 > 0).length / s.length;
  const s60 = s.filter(r => r.ex60 != null);
  const ex60 = s60.length ? s60.reduce((x, r) => x + r.ex60!, 0) / s60.length : NaN;
  const win60 = s60.length ? 100 * s60.filter(r => r.ex60! > 0).length / s60.length : NaN;
  const up60 = s60.length ? 100 * s60.filter(r => r.up60! > 0).length / s60.length : NaN;
  const flag = (ex60 > 0.5 && win60 >= 52) ? ' ★' : '';
  console.log(`  ${label.padEnd(30)} ${String(s.length).padStart(5)}筆 | 20日超額${ex20 >= 0 ? '+' : ''}${ex20.toFixed(2)}%(贏${win20.toFixed(0)}%) | 60日超額${isNaN(ex60) ? '—' : (ex60 >= 0 ? '+' : '') + ex60.toFixed(2) + '%(贏' + win60.toFixed(0) + '%)'} | 60日自己漲的比例${isNaN(up60) ? '—' : up60.toFixed(0) + '%'}${flag}`);
}

async function main() {
  const twii: OHLC[] = (await readJ(path.join(C, '^TWII.json'))).candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
  const files = (await fs.readdir(TDCC)).filter(f => /^\d{4}\.json$/.test(f));
  const all: Row[] = [];

  for (const f of files) {
    const code = f.replace('.json', '');
    const cdl = await readJ(path.join(C, `${code}.TW.json`)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 80) continue;
    const cDate = cs.map(c => c.date);
    const csAt = (d: string) => { let lo = 0, hi = cDate.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (cDate[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
    const tj = await readJ(path.join(TDCC, f));
    const wk: Wk[] = (tj?.data || []).filter((d: any) => d.holder1000Pct != null).map((d: any) => ({ date: d.date, h: d.holder1000Pct })).sort((a: Wk, b: Wk) => a.date < b.date ? -1 : 1);
    if (wk.length < 16) continue;

    for (let w = 12; w < wk.length; w++) {
      const h = wk.map(x => x.h);
      const net12 = h[w] - h[w - 12];
      // 線性斜率(過去12週)
      let sx = 0, sy = 0, sxx = 0, sxy = 0; const n = 13;
      for (let k = 0; k < n; k++) { const x = k, y = h[w - 12 + k]; sx += x; sy += y; sxx += x * x; sxy += x * y; }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      // 三段都上升(慢慢穩穩爬)
      const steadyUp = h[w] > h[w - 4] && h[w - 4] > h[w - 8] && h[w - 8] > h[w - 12];
      const steadyDown = h[w] < h[w - 4] && h[w - 4] < h[w - 8] && h[w - 8] < h[w - 12];
      // 連續未下降週數
      let consec = 0; for (let k = w; k > 0; k--) { if (h[k] >= h[k - 1] - 0.05) consec++; else break; }

      const entryDate = addDays(wk[w].date, LAG);
      let t = csAt(entryDate); if (t < 0) continue; if (cDate[t] < entryDate) t += 1;
      if (t < 0 || t + 20 >= cs.length) continue;
      const entry = cs[t].open; if (!(entry > 0)) continue;
      const mk = (a: number, b: number) => { const e = twAt(cs[a].date), x = twAt(cs[b].date); return (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0; };
      const i20 = Math.min(t + 20, cs.length - 1);
      const ret20 = (cs[i20].close / entry - 1) * 100; if (Math.abs(ret20) > 80) continue;
      const ex20 = ret20 - mk(t, i20);
      let ex60: number | null = null, up60: number | null = null;
      if (t + 60 < cs.length) { const i60 = t + 60; const ret60 = (cs[i60].close / entry - 1) * 100; if (Math.abs(ret60) <= 120) { ex60 = ret60 - mk(t, i60); up60 = ret60; } }

      all.push({ steadyUp, net12, slopePos: slope > 0, consecUp: consec, steadyDown, turnover: cs[t].close * (cs[t].volume || 0), iso: isoWeek(cs[t].date), date: cs[t].date, ex20, up20: ret20, ex60, up60 });
    }
  }
  const byW = new Map<string, Row[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: Row[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  const mid = liq[Math.floor(liq.length / 2)].date;

  const run = (label: string, pool: Row[]) => {
    console.log(`\n===== ${label} (${pool.length.toLocaleString()}筆) =====`);
    show('全體基準(液態)', pool, () => true);
    console.log('  --- 你的想法:大戶持續慢慢爬 ---');
    show('連3段都上升(12週穩穩爬)', pool, r => r.steadyUp);
    show('12週淨增≥+1% 且斜率正', pool, r => r.net12 >= 1 && r.slopePos);
    show('12週淨增≥+2%(強趨勢)', pool, r => r.net12 >= 2);
    show('連續≥8週沒下降', pool, r => r.consecUp >= 8);
    console.log('  --- 對照:大戶持續往下掉 ---');
    show('連3段都下降(持續流失)', pool, r => r.steadyDown);
  };
  run('全期', liq);
  run('前半 train', liq.filter(r => r.date < mid));
  run('後半 test', liq.filter(r => r.date >= mid));
  console.log('\n判讀:★=60日超額>0.5%且贏大盤≥52%。train+test都★才算真;只有單邊=運氣。');
}
main().catch(e => { console.error(e); process.exit(1); });
