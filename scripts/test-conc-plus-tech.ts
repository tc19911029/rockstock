/**
 * refined 集中度 + 別的指標 — 主力分點(5+20 由負轉正+濾隔日沖+不爆量) 當底，
 * 各疊一個技術確認（MACD / KD / 均線 / 動能 / 量 / 法人同買），看哪個組合贏大盤。
 * 全市場液態股、兩年、隔日開盤進場持有20日、超額對^TWII。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const FROM = '2024-07-20', FWD = 20;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface R {
  excess: number; turnover: number; iso: string; baseHit: boolean;
  macdHistPos: boolean; macdCross: boolean; kGtD: boolean; kdCross: boolean;
  aboveMA20: boolean; aboveMA60: boolean; mom20pos: boolean; volUp: boolean; instBuy: boolean;
}
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }
function ema(arr: number[], n: number): number[] { const k = 2 / (n + 1); const out: number[] = []; let prev = arr[0]; for (let i = 0; i < arr.length; i++) { prev = i === 0 ? arr[0] : arr[i] * k + prev * (1 - k); out.push(prev); } return out; }
function sma(arr: number[], n: number): (number | null)[] { const out: (number | null)[] = []; let sum = 0; for (let i = 0; i < arr.length; i++) { sum += arr[i]; if (i >= n) sum -= arr[i - n]; out.push(i >= n - 1 ? sum / n : null); } return out; }

function stat(label: string, rows: R[], pick: (r: R) => boolean) {
  const s = rows.filter(pick);
  if (s.length < 25) { console.log(`  ${label.padEnd(30)} ${s.length}筆(太少)`); return; }
  const ex = s.reduce((x, r) => x + r.excess, 0) / s.length;
  const win = 100 * s.filter(r => r.excess > 0).length / s.length;
  const flag = (ex > 0.3 && win >= 50) ? ' ★' : '';
  console.log(`  ${label.padEnd(30)} ${String(s.length).padStart(5)}筆 | 超額${ex >= 0 ? '+' : ''}${ex.toFixed(2)}% | 贏大盤${win.toFixed(0)}%${flag}`);
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
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 80) continue;
    const [bk, ins] = await Promise.all([readJ(path.join(BROKER, f)), readJ(path.join(INST, f))]);
    const bm = new Map<string, number>(); for (const d of (bk?.data || [])) bm.set(d.date, d.netDifference ?? 0);
    const im = new Map<string, number>(); for (const d of (ins?.data || [])) im.set(d.date, d.total ?? 0);
    const conc = (t: number, w: number): number | null => { if (t - w + 1 < 0) return null; let n = 0, v = 0; for (let k = t - w + 1; k <= t; k++) { if (!bm.has(cs[k].date)) return null; n += bm.get(cs[k].date)!; v += cs[k].volume; } return v > 0 ? n / v * 100 : null; };

    const close = cs.map(c => c.close);
    const dif = ema(close, 12).map((e12, i) => e12 - ema(close, 26)[i]);
    const dea = ema(dif, 9);
    const hist = dif.map((d, i) => d - dea[i]);
    const ma20 = sma(close, 20), ma60 = sma(close, 60);
    // KD(9,3,3)
    const k: number[] = [], dd: number[] = []; let pk = 50, pd = 50;
    for (let i = 0; i < cs.length; i++) {
      const lo = Math.max(0, i - 8); let hh = -Infinity, ll = Infinity;
      for (let j = lo; j <= i; j++) { hh = Math.max(hh, cs[j].high); ll = Math.min(ll, cs[j].low); }
      const rsv = hh > ll ? (cs[i].close - ll) / (hh - ll) * 100 : 50;
      pk = (2 / 3) * pk + (1 / 3) * rsv; pd = (2 / 3) * pd + (1 / 3) * pk; k.push(pk); dd.push(pd);
    }

    for (let t = 25; t + 1 + FWD < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      // refined 集中度底
      const c5 = conc(t, 5), c20 = conc(t, 20), c20p = conc(t - 5, 20);
      if (c5 == null || c20 == null || c20p == null) continue;
      let v20 = 0; for (let kk = t - 19; kk <= t; kk++) v20 += cs[kk].volume;
      const volR = v20 > 0 ? cs[t].volume / (v20 / 20) : 0;
      const baseHit = c20 > 0 && c20p <= 0 && c20 >= 1 && c20 <= 5 && c5 < 8 && volR < 1.8;

      const ret = (cs[Math.min(t + 1 + FWD, cs.length - 1)].close / cs[t + 1].open - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[Math.min(t + 1 + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;

      let v5 = 0; for (let kk = t - 4; kk <= t; kk++) v5 += cs[kk].volume;
      const inst5 = (() => { let n = 0; for (let kk = t - 4; kk <= t; kk++) { if (!im.has(cs[kk].date)) return null; n += im.get(cs[kk].date)!; } return n; })();

      all.push({
        excess: ret - mkt, turnover: cs[t].close * (cs[t].volume || 0), iso: isoWeek(cs[t].date), baseHit,
        macdHistPos: hist[t] > 0,
        macdCross: hist[t] > 0 && hist[t - 1] <= 0,
        kGtD: k[t] > dd[t],
        kdCross: k[t] > dd[t] && k[t - 1] <= dd[t - 1],
        aboveMA20: ma20[t] != null && cs[t].close > (ma20[t] as number),
        aboveMA60: ma60[t] != null && cs[t].close > (ma60[t] as number),
        mom20pos: cs[t].close > cs[t - 20].close,
        volUp: cs[t].volume > v5 / 5,
        instBuy: inst5 != null && inst5 > 0,
      });
    }
  }
  const byW = new Map<string, R[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: R[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  const base = liq.filter(r => r.baseHit); // 流動性排名在全宇宙做完，再取命中

  console.log('================================================');
  console.log(`refined 集中度 + 別的指標 — 兩年液態股，持有${FWD}日超額  (★=超額>0.3%且贏大盤≥50%)`);
  console.log(`(全液態基準供對照；底=refined 集中度命中)`);
  console.log('================================================');
  stat('全液態基準(對照)', liq, () => true);
  stat('底：refined 集中度(命中)', base, () => true);
  console.log('\n【底 + 一個技術確認】');
  stat('+ MACD 柱>0(多方)', base, r => r.macdHistPos);
  stat('+ MACD 金叉(剛翻多)', base, r => r.macdCross);
  stat('+ KD K>D', base, r => r.kGtD);
  stat('+ KD 金叉', base, r => r.kdCross);
  stat('+ 站上 MA20', base, r => r.aboveMA20);
  stat('+ 站上 MA60', base, r => r.aboveMA60);
  stat('+ 動能20日為正', base, r => r.mom20pos);
  stat('+ 量增(今>5日均量)', base, r => r.volUp);
  stat('+ 法人5日同買', base, r => r.instBuy);
  console.log('\n【底 + 兩個一起】');
  stat('+ 站上MA20 + MACD柱>0', base, r => r.aboveMA20 && r.macdHistPos);
  stat('+ 站上MA60 + 動能正', base, r => r.aboveMA60 && r.mom20pos);
  stat('+ 站上MA20 + 法人同買', base, r => r.aboveMA20 && r.instBuy);
  console.log('\n判讀：比「底(單獨)」有沒有變好；有★=超額>0.3且真的贏大盤過半。');
}
main().catch(e => { console.error(e); process.exit(1); });
