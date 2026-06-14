/**
 * 陳唯泰籌碼法回測 — 「大戶連續增加 + 散戶連續減少 + 修正過 + 多頭沒壞」到底有沒有真 edge？
 *
 * 出處：94要賺錢 2026-06-13 陳唯泰心法 = 看籌碼、看大戶有沒有跟你同一邊。
 *   篩股條件：①大戶持股連續好幾週增加 ②散戶連續三週減少（TDCC 裡＝大戶的反面，同一件事）
 *            ③股價修正過 ④多頭/長多沒壞 ⑤本益比<25 ⑥週均量>1000張
 *
 * 本腳本能測 ①③④⑥（K線+TDCC）。⑤本益比<25 無歷史快取（data/_finmind/per 全空）→ 先略過、報告標明。
 *
 * 防過擬合 + 誠實 edge：沿用 factor-grid-search 同款底座 —
 *   全市場週度液態 top500、隔日開盤進場、超額對 ^TWII（去大盤 beta）、前一年 train 找/後一年 test 驗。
 *   只有 train+test 都正、且贏大盤≥50% 才算真有料。多空 ablation 看哪一條在出力。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const TDCC = path.join(process.cwd(), 'data/chips/TW/tdcc');
const FROM = '2024-07-20';
const HORIZONS = [5, 10, 20] as const; // 進場後持有天數
const PRIMARY = 20;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Row {
  date: string; iso: string; turnover: number;
  ret: Record<number, number>;    // 各 horizon 原始報酬%
  excess: Record<number, number>; // 各 horizon 超額%（去大盤）
  holderConsecUp: number;         // 大戶該級距「連續上升」週數
  holderConsecDown: number;       // 大戶該級距「連續下降」週數（＝散戶連增，避雷側）
  holderChg: number | null;       // 大戶單週變化（已知偏弱基準）
  devMA20: number; off20High: number; ma20up: boolean; ma60up: boolean;
  avgVol20: number;               // 20日均量(張)
  inst5: number | null;           // 法人5日合計買賣超(張)
}

async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }

function agg(rows: Row[], h: number) {
  if (rows.length === 0) return { ex: 0, win: 0, raw: 0, n: 0 };
  const ex = rows.reduce((s, r) => s + r.excess[h], 0) / rows.length;
  const raw = rows.reduce((s, r) => s + r.ret[h], 0) / rows.length;
  const win = 100 * rows.filter(r => r.excess[h] > 0).length / rows.length;
  return { ex, win, raw, n: rows.length };
}

/** 一檔股票某級距週度大戶%序列（升冪、濾 null），算出「連續上升」週數 ending ≤ asOfDate */
function consecUp(series: { date: string; v: number }[], asOfDate: string): number {
  // 找出最後一個 date ≤ asOfDate 的索引
  let last = -1;
  for (let i = series.length - 1; i >= 0; i--) { if (series[i].date <= asOfDate) { last = i; break; } }
  if (last <= 0) return 0;
  let cnt = 0;
  for (let i = last; i >= 1; i--) { if (series[i].v > series[i - 1].v + 1e-9) cnt++; else break; }
  return cnt;
}
/** 連續下降週數 ending ≤ asOfDate（避雷側：大戶連減＝散戶連增）*/
function consecDown(series: { date: string; v: number }[], asOfDate: string): number {
  let last = -1;
  for (let i = series.length - 1; i >= 0; i--) { if (series[i].date <= asOfDate) { last = i; break; } }
  if (last <= 0) return 0;
  let cnt = 0;
  for (let i = last; i >= 1; i--) { if (series[i].v < series[i - 1].v - 1e-9) cnt++; else break; }
  return cnt;
}

async function main() {
  const twii: OHLC[] = (await readJ(path.join(C, '^TWII.json'))).candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
  const files = (await fs.readdir(TDCC)).filter(f => /^\d{4,}\.json$/.test(f));
  const all: Row[] = [];

  for (const f of files) {
    const code = f.replace('.json', '');
    const cdl = await readJ(path.join(C, `${code}.TW.json`)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 80) continue;
    const [ins, tj] = await Promise.all([readJ(path.join(INST, f)), readJ(path.join(TDCC, f))]);
    const im = new Map<string, number>(); for (const d of (ins?.data || [])) im.set(d.date, d.total ?? 0);

    // 三個級距各自的週度序列（升冪、濾 null）
    const tdccRows = (tj?.data || []).filter((r: any) => r && r.date).sort((a: any, b: any) => a.date < b.date ? -1 : 1);
    const seriesOf = (key: string) => tdccRows.filter((r: any) => r[key] != null).map((r: any) => ({ date: r.date as string, v: r[key] as number }));
    const ser100 = seriesOf('holder100Pct'), ser400 = seriesOf('holder400Pct'), ser1000 = seriesOf('holder1000Pct');
    const tierSeries = (px: number) => px >= 250 ? ser100 : px >= 50 ? ser400 : ser1000;
    // 單週變化（最後兩筆）
    const holderChgAt = (px: number, date: string): number | null => {
      const s = tierSeries(px);
      let last = -1; for (let i = s.length - 1; i >= 0; i--) { if (s[i].date <= date) { last = i; break; } }
      if (last <= 0) return null;
      return s[last].v - s[last - 1].v;
    };

    const close = cs.map(c => c.close);
    const ma = (t: number, n: number) => { let s = 0; for (let j = t - n + 1; j <= t; j++) s += close[j]; return s / n; };
    const maxFwd = Math.max(...HORIZONS);

    for (let t = 60; t + 1 + maxFwd < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      const e = twAt(cs[t + 1].date); if (e < 0) continue;
      const ret: Record<number, number> = {}, excess: Record<number, number> = {};
      let bad = false;
      for (const h of HORIZONS) {
        const xi = Math.min(t + 1 + h, cs.length - 1);
        const r = (cs[xi].close / cs[t + 1].open - 1) * 100;
        if (Math.abs(r) > 80) { bad = true; break; }
        const x = twAt(cs[xi].date);
        const mkt = (x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
        ret[h] = r; excess[h] = r - mkt;
      }
      if (bad) continue;

      const px = cs[t].close;
      const m20 = ma(t, 20), m60 = ma(t, 60);
      let v20 = 0; for (let kk = t - 19; kk <= t; kk++) v20 += cs[kk].volume;
      let hi20 = -Infinity; for (let kk = t - 19; kk <= t; kk++) hi20 = Math.max(hi20, cs[kk].high);
      const inst5 = (() => { let n = 0; for (let kk = t - 4; kk <= t; kk++) { if (!im.has(cs[kk].date)) return null; n += im.get(cs[kk].date)!; } return n; })();

      all.push({
        date: cs[t].date, iso: isoWeek(cs[t].date), turnover: px * (cs[t].volume || 0),
        ret, excess,
        holderConsecUp: consecUp(tierSeries(px), cs[t].date),
        holderConsecDown: consecDown(tierSeries(px), cs[t].date),
        holderChg: holderChgAt(px, cs[t].date),
        devMA20: (px / m20 - 1) * 100, off20High: (px / hi20 - 1) * 100,
        ma20up: px > m20, ma60up: px > m60,
        avgVol20: v20 / 20, inst5,
      });
    }
  }

  // 週度液態 top500（同 factor-grid）
  const byW = new Map<string, Row[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: Row[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  const mid = liq[Math.floor(liq.length / 2)].date;
  const train = liq.filter(r => r.date < mid), test = liq.filter(r => r.date >= mid);
  console.log(`液態樣本 ${liq.length} 筆 | train ${train.length}(${liq[0].date}~) | test ${test.length}(${mid}~${liq[liq.length - 1].date})`);
  console.log(`大盤^TWII 同期：train 平均報酬會被當基準扣掉（excess=超額）\n`);

  // ── 條件積木 ──
  const pulledBack = (r: Row) => r.off20High < -5;       // 修正過：距20日高 >5%
  const trendOK = (r: Row) => r.ma60up;                  // 多頭沒壞：站上季線
  const volOK = (r: Row) => r.avgVol20 > 1000;           // 週均量>1000張(等值)
  const instBuy = (r: Row) => r.inst5 != null && r.inst5 > 0;

  // ── 變體（ablation）──
  type V = { name: string; pred: (r: Row) => boolean };
  const variants: V[] = [
    { name: '基準：全液態股', pred: () => true },
    { name: '大戶單週增(已知偏弱基準)', pred: r => r.holderChg != null && r.holderChg > 0.1 },
    { name: '大戶連2週增', pred: r => r.holderConsecUp >= 2 },
    { name: '大戶連3週增', pred: r => r.holderConsecUp >= 3 },
    { name: '大戶連3週增 +修正過', pred: r => r.holderConsecUp >= 3 && pulledBack(r) },
    { name: '大戶連3週增 +多頭沒壞', pred: r => r.holderConsecUp >= 3 && trendOK(r) },
    { name: '★陳唯泰核心:連3增+修正+多頭', pred: r => r.holderConsecUp >= 3 && pulledBack(r) && trendOK(r) },
    { name: '★+量>1000張', pred: r => r.holderConsecUp >= 3 && pulledBack(r) && trendOK(r) && volOK(r) },
    { name: '★+法人同買(確認)', pred: r => r.holderConsecUp >= 3 && pulledBack(r) && trendOK(r) && instBuy(r) },
    { name: '大戶連4週增 +修正+多頭', pred: r => r.holderConsecUp >= 4 && pulledBack(r) && trendOK(r) },
    // 反面（避雷對照，使用者過往發現這側才穩）
    { name: '🚫散戶連3週增(=大戶連3減)', pred: r => r.holderConsecDown >= 3 },
    { name: '🚫大戶單週減', pred: r => r.holderChg != null && r.holderChg < -0.1 },
  ];

  console.log('========== 陳唯泰籌碼法 ablation（持有20日，超額對大盤）==========');
  console.log('變體                                    train超額/勝率 → test超額/勝率   (train/test筆數)  raw報酬');
  for (const v of variants) {
    const tr = agg(train.filter(v.pred), PRIMARY), te = agg(test.filter(v.pred), PRIMARY);
    const verdict = tr.ex > 0 && te.ex > 0 && te.win >= 50 ? '  ✅真有料'
      : tr.ex < 0 && te.ex < 0 ? '  🚫兩年都負(避雷側)' : '';
    console.log(`  ${v.name.padEnd(36)} ${sgn(tr.ex)}/${tr.win.toFixed(0)}% → ${sgn(te.ex)}/${te.win.toFixed(0)}%   (${tr.n}/${te.n})  raw ${sgn(te.raw)}${verdict}`);
  }

  console.log('\n========== ★核心組合 在不同持有天數的表現（看短中線）==========');
  const core = (r: Row) => r.holderConsecUp >= 3 && pulledBack(r) && trendOK(r);
  console.log('持有天數    train超額/勝率 → test超額/勝率   raw報酬(test)');
  for (const h of HORIZONS) {
    const tr = agg(train.filter(core), h), te = agg(test.filter(core), h);
    console.log(`  d${String(h).padEnd(3)}     ${sgn(tr.ex)}/${tr.win.toFixed(0)}% → ${sgn(te.ex)}/${te.win.toFixed(0)}%    raw ${sgn(te.raw)}  (n=${te.n})`);
  }

  console.log('\n判讀準則：');
  console.log('  真有料 = train+test 都正 且 test 贏大盤≥50%。raw 高但 excess≈0/負 = 只是吃大盤beta，不算 edge。');
  console.log('  ⚠️ 本益比<25 因無歷史 PER 快取未納入；量>1000張對液態股幾乎恆真。');
}
function sgn(x: number) { return (x >= 0 ? '+' : '') + x.toFixed(2) + '%'; }
main().catch(e => { console.error(e); process.exit(1); });
