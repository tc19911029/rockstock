/**
 * 因子大搜索 — 各種「進場底 × 確認指標」全跑一遍，找真的能贏大盤的組合。
 * 防過擬合：前一年(train)找、後一年(test)驗；只有兩年都站得住才算數。
 * 全市場液態股、隔日開盤進場持有20日、超額對^TWII。資料 2024-07~2026-06。
 *
 * 因子：主力分點集中度(5/20)、法人(5日)、動能、乖離、MACD、KD、均線、量、大戶持股。
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
  date: string; iso: string; turnover: number; excess: number;
  conc5: number; conc20: number; conc20p: number; inst5: number | null;
  mom20: number; devMA20: number; volR: number; dip5: number;
  macdHist: number; macdHistPrev: number; k: number; d: number; kPrev: number; dPrev: number;
  ma20up: boolean; ma60up: boolean; holderChg: number | null; holderLvl: number | null;
  todayChg: number; upShadow: number; volSpike: boolean;
}
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }
function ema(arr: number[], n: number): number[] { const k = 2 / (n + 1); const out: number[] = []; let prev = arr[0]; for (let i = 0; i < arr.length; i++) { prev = i === 0 ? arr[0] : arr[i] * k + prev * (1 - k); out.push(prev); } return out; }

function agg(rows: Row[]) { if (rows.length === 0) return { ex: 0, win: 0, n: 0 }; const ex = rows.reduce((s, r) => s + r.excess, 0) / rows.length; const win = 100 * rows.filter(r => r.excess > 0).length / rows.length; return { ex, win, n: rows.length }; }

async function main() {
  const twii: OHLC[] = (await readJ(path.join(C, '^TWII.json'))).candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
  const files = (await fs.readdir(BROKER)).filter(f => /^\d{4}\.json$/.test(f));
  const all: Row[] = [];

  for (const f of files) {
    const code = f.replace('.json', '');
    const cdl = await readJ(path.join(C, `${code}.TW.json`)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 80) continue;
    const [bk, ins, tj] = await Promise.all([readJ(path.join(BROKER, f)), readJ(path.join(INST, f)), readJ(path.join(TDCC, f))]);
    const bm = new Map<string, number>(); for (const d of (bk?.data || [])) bm.set(d.date, d.netDifference ?? 0);
    const im = new Map<string, number>(); for (const d of (ins?.data || [])) im.set(d.date, d.total ?? 0);
    // 大戶持股(依股價挑級距)週變化 map：date -> Δpct
    const hrows: { date: string; v: number }[] = [];
    for (const d of (tj?.data || [])) { const px = 0; void px; }
    const conc = (t: number, w: number): number | null => { if (t - w + 1 < 0) return null; let n = 0, v = 0; for (let k = t - w + 1; k <= t; k++) { if (!bm.has(cs[k].date)) return null; n += bm.get(cs[k].date)!; v += cs[k].volume; } return v > 0 ? n / v * 100 : null; };

    const close = cs.map(c => c.close);
    const e12 = ema(close, 12), e26 = ema(close, 26);
    const dif = e12.map((x, i) => x - e26[i]); const dea = ema(dif, 9); const hist = dif.map((x, i) => x - dea[i]);
    const k: number[] = [], dd: number[] = []; let pk = 50, pd = 50;
    for (let i = 0; i < cs.length; i++) { const lo = Math.max(0, i - 8); let hh = -Infinity, ll = Infinity; for (let j = lo; j <= i; j++) { hh = Math.max(hh, cs[j].high); ll = Math.min(ll, cs[j].low); } const rsv = hh > ll ? (cs[i].close - ll) / (hh - ll) * 100 : 50; pk = 2 / 3 * pk + 1 / 3 * rsv; pd = 2 / 3 * pd + 1 / 3 * pk; k.push(pk); dd.push(pd); }
    const ma = (t: number, n: number) => { let s = 0; for (let j = t - n + 1; j <= t; j++) s += close[j]; return s / n; };
    // 大戶持股級距週變化（依當前股價挑 100/400/1000）
    const tdccRows = (tj?.data || []).filter((r: any) => r).sort((a: any, b: any) => a.date < b.date ? -1 : 1);
    const holderAt = (t: number): { chg: number | null; lvl: number | null } => {
      const px = cs[t].close; const key = px >= 250 ? 'holder100Pct' : px >= 50 ? 'holder400Pct' : 'holder1000Pct';
      const date = cs[t].date; let cur: any = null, prev: any = null;
      for (let i = tdccRows.length - 1; i >= 0; i--) { if (tdccRows[i].date <= date) { cur = tdccRows[i]; prev = tdccRows[i - 1] ?? null; break; } }
      const lvl = cur && cur[key] != null ? cur[key] : null;
      const chg = (cur && prev && cur[key] != null && prev[key] != null) ? cur[key] - prev[key] : null;
      return { chg, lvl };
    };

    for (let t = 30; t + 1 + FWD < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      const c5 = conc(t, 5), c20 = conc(t, 20), c20p = conc(t - 5, 20);
      if (c5 == null || c20 == null || c20p == null) continue;
      const ret = (cs[Math.min(t + 1 + FWD, cs.length - 1)].close / cs[t + 1].open - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[Math.min(t + 1 + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
      let v20 = 0; for (let kk = t - 19; kk <= t; kk++) v20 += cs[kk].volume;
      const inst5 = (() => { let n = 0; for (let kk = t - 4; kk <= t; kk++) { if (!im.has(cs[kk].date)) return null; n += im.get(cs[kk].date)!; } return n; })();
      const m20 = ma(t, 20);
      const o = cs[t].open, h = cs[t].high, l = cs[t].low, cl = cs[t].close;
      const range = h - l;
      const hd = holderAt(t);
      all.push({
        date: cs[t].date, iso: isoWeek(cs[t].date), turnover: cs[t].close * (cs[t].volume || 0), excess: ret - mkt,
        conc5: c5, conc20: c20, conc20p: c20p, inst5,
        mom20: (cs[t].close / cs[t - 20].close - 1) * 100, devMA20: (cs[t].close / m20 - 1) * 100,
        volR: v20 > 0 ? cs[t].volume / (v20 / 20) : 0, dip5: (cs[t].close / cs[t - 5].close - 1) * 100,
        macdHist: hist[t], macdHistPrev: hist[t - 1], k: k[t], d: dd[t], kPrev: k[t - 1], dPrev: dd[t - 1],
        ma20up: cs[t].close > m20, ma60up: cs[t].close > ma(t, 60), holderChg: hd.chg, holderLvl: hd.lvl,
        todayChg: o > 0 ? (cl / o - 1) * 100 : 0,
        upShadow: range > 0 ? (h - Math.max(o, cl)) / range : 0,
        volSpike: v20 > 0 ? cs[t].volume > 2 * (v20 / 20) : false,
      });
    }
  }
  const byW = new Map<string, Row[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: Row[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  const mid = liq[Math.floor(liq.length / 2)].date;
  const train = liq.filter(r => r.date < mid), test = liq.filter(r => r.date >= mid);
  console.log(`液態 ${liq.length} 筆 | train ${train.length}(${liq[0].date}~) | test ${test.length}(${mid}~)`);

  // 大戶持股「水位高」top10%（s_track 原始宣稱：千張大戶% 高=好，重測）
  const hlrows = liq.filter(r => r.holderLvl != null);
  const hlSorted = [...hlrows].sort((a, b) => (b.holderLvl as number) - (a.holderLvl as number));
  const hiHolderLvl = new Set(hlSorted.slice(0, Math.floor(hlrows.length * 0.1)));

  // ── 進場底 ──
  const bases: [string, (r: Row) => boolean][] = [
    ['集中度refined(5+20轉正)', r => r.conc20 > 0 && r.conc20p <= 0 && r.conc20 >= 1 && r.conc20 <= 5 && r.conc5 < 8 && r.volR < 1.8],
    ['集中度5日>3', r => r.conc5 > 3],
    ['近5日跌>3%', r => r.dip5 < -3],
    ['動能20日 top(>10%)', r => r.mom20 > 10],
    ['超跌(乖離MA20<-8%)', r => r.devMA20 < -8],
    ['法人5日買超', r => r.inst5 != null && r.inst5 > 0],
    ['大戶持股增加', r => r.holderChg != null && r.holderChg > 0.1],
    // 避雷候選底（懷疑系統性變差的）
    ['追高(乖離MA20>15%)', r => r.devMA20 > 15],
    ['集中度5日爆高>10(隔日沖)', r => r.conc5 > 10],
    ['近5日漲>10(追漲)', r => r.dip5 > 10],
    ['法人5日大賣', r => r.inst5 != null && r.inst5 < 0],
    ['大戶持股減少', r => r.holderChg != null && r.holderChg < -0.1],
    ['大戶持股水位最高10%', r => hiHolderLvl.has(r)],
    // 價量危險訊號（重測「是否反指」）
    ['長黑K(今跌>3%)', r => r.todayChg < -3],
    ['爆量長黑(跌>3%+量2倍)', r => r.todayChg < -3 && r.volSpike],
    ['長上影(上影>50%振幅)', r => r.upShadow > 0.5],
    ['高檔爆量(乖離>10+量2倍)', r => r.devMA20 > 10 && r.volSpike],
  ];
  // ── 確認指標（正反都放） ──
  const filters: [string, (r: Row) => boolean][] = [
    ['無(底單獨)', () => true],
    ['+法人同買', r => r.inst5 != null && r.inst5 > 0],
    ['+站上MA20', r => r.ma20up],
    ['+站上MA60', r => r.ma60up],
    ['+MACD柱>0', r => r.macdHist > 0],
    ['+MACD金叉', r => r.macdHist > 0 && r.macdHistPrev <= 0],
    ['+KD K>D', r => r.k > r.d],
    ['+動能正', r => r.mom20 > 0],
    ['+集中度5日>0', r => r.conc5 > 0],
    ['+大戶持股增', r => r.holderChg != null && r.holderChg > 0],
    ['+不超漲(乖離<15)', r => r.devMA20 < 15],
    // 反向確認（避雷）
    ['+跌破MA20', r => !r.ma20up],
    ['+MACD柱<0', r => r.macdHist < 0],
    ['+KD K<D', r => r.k < r.d],
    ['+法人同賣', r => r.inst5 != null && r.inst5 < 0],
  ];

  type Res = { name: string; tr: ReturnType<typeof agg>; te: ReturnType<typeof agg> };
  const results: Res[] = [];
  for (const [bn, bp] of bases) {
    for (const [fn, fp] of filters) {
      const pred = (r: Row) => bp(r) && fp(r);
      results.push({ name: `${bn} ${fn}`, tr: agg(train.filter(pred)), te: agg(test.filter(pred)) });
    }
  }
  // 只看樣本夠的（train/test 各 ≥60）
  const valid = results.filter(r => r.tr.n >= 60 && r.te.n >= 60);
  console.log('\n========== 兩年都站得住的(train 正 且 test 正，依 test 超額排) ==========');
  const robust = valid.filter(r => r.tr.ex > 0 && r.te.ex > 0).sort((a, b) => b.te.ex - a.te.ex);
  console.log('組合                                     train超額/勝  →  test超額/勝  (筆數)');
  for (const r of robust.slice(0, 18)) {
    console.log(`  ${r.name.padEnd(36)} ${(r.tr.ex >= 0 ? '+' : '') + r.tr.ex.toFixed(2)}%/${r.tr.win.toFixed(0)}% → ${(r.te.ex >= 0 ? '+' : '') + r.te.ex.toFixed(2)}%/${r.te.win.toFixed(0)}%  (${r.tr.n}/${r.te.n})`);
  }
  console.log(`\n（共 ${valid.length} 個有效組合，其中 ${robust.length} 個兩年都正。test贏大盤≥50%的：${robust.filter(r => r.te.win >= 50).length} 個）`);
  console.log('\n========== test 表現最好(不管 train) — 對照看哪些是過擬合 ==========');
  for (const r of [...valid].sort((a, b) => b.te.ex - a.te.ex).slice(0, 8)) {
    const flag = r.tr.ex > 0 ? '' : ' ⚠train負(過擬合嫌疑)';
    console.log(`  ${r.name.padEnd(36)} test ${(r.te.ex >= 0 ? '+' : '') + r.te.ex.toFixed(2)}%/${r.te.win.toFixed(0)}% (train ${(r.tr.ex >= 0 ? '+' : '') + r.tr.ex.toFixed(2)}%)${flag}`);
  }

  console.log('\n========== 🚫 避雷：兩年都最差(train 負 且 test 負，依 test 超額升冪) ==========');
  const avoid = valid.filter(r => r.tr.ex < 0 && r.te.ex < 0).sort((a, b) => a.te.ex - b.te.ex);
  console.log('組合                                     train超額/勝  →  test超額/勝  (筆數)');
  for (const r of avoid.slice(0, 15)) {
    console.log(`  ${r.name.padEnd(36)} ${r.tr.ex.toFixed(2)}%/${r.tr.win.toFixed(0)}% → ${r.te.ex.toFixed(2)}%/${r.te.win.toFixed(0)}%  (${r.tr.n}/${r.te.n})`);
  }
  console.log(`\n（${avoid.length} 個組合兩年都負＝可信避雷；其中 test 贏大盤<42%(明顯偏弱)的：${avoid.filter(r => r.te.win < 42).length} 個）`);

  console.log('\n判讀：');
  console.log('  正向：要 train+test 都正、test 贏大盤≥50% 才算真有料（幾乎沒有）。');
  console.log('  避雷：兩年都負＝系統性偏弱，當「別買/別追」清單比選股可信。');
}
main().catch(e => { console.error(e); process.exit(1); });
