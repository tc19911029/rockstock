/**
 * 籌碼集中度窗比較 — 5日 / 10日 / 20日 哪個窗、哪種組合最有預測力（全市場，非單一飆股）。
 * 主力分點集中度。液態股(每週成交額前500)、過去一年、隔日基準持有20日、超額對^TWII。
 * 回答：①單看 5日夠嗎 ②5日+10日 vs 5日+20日 哪個好。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const FROM = '2025-06-12', FWD = 20;

interface OHLC { date: string; open: number; close: number; volume: number }
interface R {
  c5: number; c10: number; c20: number; c10p: number; c20p: number; volR: number;
  turnover: number; iso: string; excess: number;
}
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }

function stat(label: string, rows: R[], pick: (r: R) => boolean) {
  const s = rows.filter(pick);
  if (s.length < 30) { console.log(`  ${label.padEnd(30)} ${s.length}筆(太少)`); return; }
  const ex = s.reduce((x, r) => x + r.excess, 0) / s.length;
  const win = 100 * s.filter(r => r.excess > 0).length / s.length;
  const flag = (ex > 0 && win >= 50) ? ' ★' : '';
  console.log(`  ${label.padEnd(30)} ${String(s.length).padStart(5)}筆 | 超額${ex >= 0 ? '+' : ''}${ex.toFixed(2)}% | 贏大盤${win.toFixed(0)}%${flag}`);
}
function topFrac(rows: R[], key: (r: R) => number, frac: number) {
  const v = [...rows]; v.sort((a, b) => key(b) - key(a));
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
    const bk = await readJ(path.join(BROKER, f));
    const bm = new Map<string, number>(); for (const d of (bk?.data || [])) bm.set(d.date, d.netDifference ?? 0);
    const conc = (t: number, w: number): number | null => { if (t - w + 1 < 0) return null; let n = 0, v = 0; for (let k = t - w + 1; k <= t; k++) { if (!bm.has(cs[k].date)) return null; n += bm.get(cs[k].date)!; v += cs[k].volume; } return v > 0 ? n / v * 100 : null; };
    for (let t = 25; t + 1 + FWD < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      const c5 = conc(t, 5), c10 = conc(t, 10), c20 = conc(t, 20), c10p = conc(t - 5, 10), c20p = conc(t - 5, 20);
      if (c5 == null || c10 == null || c20 == null || c10p == null || c20p == null) continue;
      const ret = (cs[Math.min(t + 1 + FWD, cs.length - 1)].close / cs[t + 1].open - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[Math.min(t + 1 + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
      let v20 = 0; for (let k = t - 19; k <= t; k++) v20 += cs[k].volume;
      all.push({ c5, c10, c20, c10p, c20p, volR: v20 > 0 ? cs[t].volume / (v20 / 20) : 0, turnover: cs[t].close * (cs[t].volume || 0), iso: isoWeek(cs[t].date), excess: ret - mkt });
    }
  }
  const byW = new Map<string, R[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: R[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }

  const hi5 = topFrac(liq, r => r.c5, 0.1), hi10 = topFrac(liq, r => r.c10, 0.1), hi20 = topFrac(liq, r => r.c20, 0.1);
  console.log('================================================');
  console.log(`集中度窗比較 — 過去一年液態股 ${liq.length.toLocaleString()} 筆，持有${FWD}日超額對大盤  (★=超額>0且贏大盤≥50%)`);
  console.log('================================================');
  stat('全體基準', liq, () => true);
  console.log('\n【單看一個窗，取最集中10%】');
  stat('① 5日集中度 top10%', liq, r => hi5.has(r));
  stat('② 10日集中度 top10%', liq, r => hi10.has(r));
  stat('③ 20日集中度 top10%', liq, r => hi20.has(r));
  console.log('\n【refined 組合：由負轉正+1~5%+5日<8濾隔日沖+不爆量】');
  stat('④ 5日+10日（10日由負轉正）', liq, r => r.c10 > 0 && r.c10p <= 0 && r.c10 >= 1 && r.c10 <= 5 && r.c5 < 8 && r.volR < 1.8);
  stat('⑤ 5日+20日（20日由負轉正·現行）', liq, r => r.c20 > 0 && r.c20p <= 0 && r.c20 >= 1 && r.c20 <= 5 && r.c5 < 8 && r.volR < 1.8);
  console.log('\n【單看5日的幾種版本】');
  stat('⑥ 只看5日 >3%', liq, r => r.c5 > 3);
  stat('⑦ 只看5日 1~8%（濾隔日沖）', liq, r => r.c5 >= 1 && r.c5 <= 8);
  console.log('\n判讀：超額越高、贏大盤越過50%越好。比④⑤看 5+10 還是 5+20 強；比⑥⑦看單5日夠不夠。');
}
main().catch(e => { console.error(e); process.exit(1); });
