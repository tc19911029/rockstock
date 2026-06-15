/**
 * 籌碼選股「怎麼搭配好」大對照 — 11 套變體同資料同期間回測。
 *
 * 軸：集中度看誰(法人/主力分點) × 型態(高>8 / 在爬 / 由負轉正低) × 要不要加法人(連買/淨買)。
 * 進場隔日開盤、持有 d5/d10/d20、扣來回成本、vs ^TWII 超額、按日期中點切 train/test。
 * 統計用「全部命中」(不設 top15)才看得出訊號真本事。
 *
 * 用法：npx tsx scripts/compare-w-variants.ts
 */
import { promises as fs } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { FEE_RATES } from '../lib/portfolio/fees';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER_DIR = path.join(process.cwd(), 'data/chips/TW/broker');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');

const COST = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100;
const HOLD = [5, 10, 20];
const COOLDOWN = 5;
const NEED = 25; // 20日由負轉正要回看 20+5
// 只測這段「訊號日」(全部變體對齊同一期間才公平)
const START = '2025-06-01';
const END = '2026-06-30';

function readJson(p: string): any | null { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const winPct = (xs: number[]) => xs.length ? 100 * xs.filter(x => x > 0).length / xs.length : NaN;

interface RC { date: string; open: number; high: number; low: number; close: number; volume: number }
function conc(map: Map<string, number>, cs: RC[], t: number, w: number): number | null {
  if (t - w + 1 < 0) return null;
  let n = 0, v = 0;
  for (let k = t - w + 1; k <= t; k++) { if (!map.has(cs[k].date)) return null; n += map.get(cs[k].date)!; v += cs[k].volume || 0; }
  return v > 0 ? n / v * 100 : null;
}

interface Ctx {
  drop5: number; today: number; volR: number;
  bC5: number | null; bC5p: number | null; bC20: number | null; bC20p: number | null;
  iC5: number | null; iC5p: number | null; iSum: number | null; iConsec: number | null;
}

// 11 套變體（hit predicate）
const VARIANTS: { key: string; label: string; hit: (c: Ctx) => boolean }[] = [
  { key: '1', label: '最初W 法人5日集中度>8(高)', hit: c => c.drop5 < -3 && c.bC5 != null /*data*/ && c.iC5 != null && c.iC5 > 8 },
  { key: '2', label: '正版W 主力分點5日>8(高)', hit: c => c.drop5 < -3 && c.bC5 != null && c.bC5 > 8 },
  { key: '3', label: 'W現行 主力20日翻正低1~5', hit: c => c.bC20 != null && c.bC20p != null && c.bC20 > 0 && c.bC20p <= 0 && c.bC20 >= 1 && c.bC20 <= 5 && c.bC5 != null && c.bC5 < 8 && c.volR < 1.8 },
  { key: '4', label: 'X 跌/長黑+法人淨買(核心)', hit: c => (c.drop5 < -3 || c.today < -3) && c.iSum != null && c.iSum > 0 },
  { key: '5', label: 'Y 主力爬+法人連買≥2', hit: c => c.drop5 < -2 && c.bC5 != null && c.bC5p != null && c.bC5 > 0 && c.bC5 > c.bC5p && c.bC5 <= 12 && c.volR < 2 && c.iSum != null && c.iSum > 0 && c.iConsec != null && c.iConsec >= 2 },
  { key: '6', label: '你① 主力分點5日翻正低1~5', hit: c => c.bC5 != null && c.bC5p != null && c.bC5 > 0 && c.bC5p <= 0 && c.bC5 >= 1 && c.bC5 <= 5 && c.volR < 1.8 },
  { key: '7', label: '你② 法人5日翻正低1~5', hit: c => c.iC5 != null && c.iC5p != null && c.iC5 > 0 && c.iC5p <= 0 && c.iC5 >= 1 && c.iC5 <= 5 && c.iC5 < 8 && c.volR < 1.8 },
  { key: '8', label: '跌+主力分點集中度在爬', hit: c => c.drop5 < -2 && c.bC5 != null && c.bC5p != null && c.bC5 > 0 && c.bC5 > c.bC5p && c.bC5 <= 12 && c.volR < 2 },
  { key: '9', label: '跌+法人集中度在爬', hit: c => c.drop5 < -2 && c.iC5 != null && c.iC5p != null && c.iC5 > 0 && c.iC5 > c.iC5p && c.iC5 <= 12 && c.volR < 2 },
  { key: '10', label: '跌+主力分點爬+法人也爬', hit: c => c.drop5 < -2 && c.bC5 != null && c.bC5p != null && c.bC5 > 0 && c.bC5 > c.bC5p && c.bC5 <= 12 && c.volR < 2 && c.iC5 != null && c.iC5p != null && c.iC5 > 0 && c.iC5 > c.iC5p && c.iC5 <= 12 },
  { key: '11', label: '跌+法人連買≥2(無集中度)', hit: c => c.drop5 < -2 && c.iSum != null && c.iSum > 0 && c.iConsec != null && c.iConsec >= 2 },
];

interface Trade { entryDate: string; net: number; excess: number }
const store: Record<string, Record<number, Trade[]>> = {};
for (const v of VARIANTS) store[v.key] = { 5: [], 10: [], 20: [] };

async function main() {
  const twii = readJson(TWII); const twC: RC[] = twii?.candles || twii || [];
  const twClose = new Map<string, number>(); for (const c of twC) twClose.set(c.date, c.close);

  const t0 = Date.now();
  let processed = 0, skipped = 0, iters = 0, winIters = 0;
  const files = (await fs.readdir(INST_DIR)).filter(f => /^\d{4,}\.json$/.test(f));
  for (const f of files) {
    const code = f.replace('.json', '');
    const inst = readJson(path.join(INST_DIR, f)); const broker = readJson(path.join(BROKER_DIR, f));
    const cdl = readJson(path.join(CANDLE_DIR, `${code}.TW.json`));
    if (!inst || !broker || !cdl) { skipped++; continue; }
    const cs: RC[] = (cdl.candles || []).filter((c: RC) => c.close > 0);
    if (cs.length < NEED + 25) { skipped++; continue; }
    processed++;
    const bMap = new Map<string, number>(); for (const d of broker.data || []) bMap.set(d.date, d.netDifference ?? 0);
    const iMap = new Map<string, number>(); for (const d of inst.data || []) iMap.set(d.date, d.total ?? 0);

    const last: Record<string, number> = {}; for (const v of VARIANTS) last[v.key] = -99;
    for (let t = NEED; t < cs.length - 1; t++) {
      iters++;
      if (cs[t].date < START || cs[t].date > END) continue; // 只測指定期間的訊號日
      winIters++;
      let v20 = 0; for (let k = t - 19; k <= t; k++) v20 += cs[k].volume || 0;
      // 法人 5 日加總 + 連買
      let iSum: number | null = 0; for (let k = t - 4; k <= t; k++) { if (!iMap.has(cs[k].date)) { iSum = null; break; } iSum += iMap.get(cs[k].date)!; }
      let iConsec: number | null = null;
      if (iMap.has(cs[t].date)) { iConsec = 0; for (let k = t; k >= 0; k--) { if (!iMap.has(cs[k].date)) break; if ((iMap.get(cs[k].date) ?? 0) > 0) iConsec++; else break; } }
      const c: Ctx = {
        drop5: (cs[t].close / cs[t - 5].close - 1) * 100,
        today: cs[t].open > 0 ? (cs[t].close / cs[t].open - 1) * 100 : 0,
        volR: v20 > 0 ? (cs[t].volume || 0) / (v20 / 20) : 0,
        bC5: conc(bMap, cs, t, 5), bC5p: conc(bMap, cs, t - 5, 5),
        bC20: conc(bMap, cs, t, 20), bC20p: conc(bMap, cs, t - 5, 20),
        iC5: conc(iMap, cs, t, 5), iC5p: conc(iMap, cs, t - 5, 5),
        iSum, iConsec,
      };
      for (const v of VARIANTS) {
        if (!v.hit(c)) continue;
        if (t - last[v.key] <= COOLDOWN) continue;
        const entry = cs[t + 1]; if (!entry || !(entry.open > 0)) continue;
        if (entry.open === entry.high && entry.low > 0 && (entry.high - entry.low) / entry.low < 0.005) continue;
        if (Math.abs(entry.open / cs[t].close - 1) > 0.25) continue;
        last[v.key] = t;
        for (const h of HOLD) {
          const ex = cs[t + 1 + h]; if (!ex || !(ex.close > 0)) continue;
          const net = (ex.close / entry.open - 1) * 100 - COST;
          const tw0 = twClose.get(entry.date), tw1 = twClose.get(ex.date);
          const idx = tw0 && tw1 ? (tw1 / tw0 - 1) * 100 : NaN;
          store[v.key][h].push({ entryDate: entry.date, net, excess: Number.isFinite(idx) ? net - idx : NaN });
        }
      }
    }
  }

  // 以 d20 超額排序輸出
  const rows = VARIANTS.map(v => {
    const t20 = store[v.key][20].slice().sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    const ex = (h: number) => store[v.key][h].map(x => x.excess).filter(Number.isFinite);
    const mid = t20.length ? t20[t20.length >> 1].entryDate : '';
    const exTr = t20.filter(x => x.entryDate < mid).map(x => x.excess).filter(Number.isFinite);
    const exTe = t20.filter(x => x.entryDate >= mid).map(x => x.excess).filter(Number.isFinite);
    const beat = ex(20).length ? 100 * ex(20).filter(x => x > 0).length / ex(20).length : NaN;
    return {
      v, n: t20.length, net20: mean(store[v.key][20].map(x => x.net)), win20: winPct(store[v.key][20].map(x => x.net)),
      e5: mean(ex(5)), e10: mean(ex(10)), e20: mean(ex(20)), beat, tr: mean(exTr), te: mean(exTe),
      bothPos: mean(exTr) > 0 && mean(exTe) > 0,
    };
  }).sort((a, b) => (b.e20 || -99) - (a.e20 || -99));

  const totalHits = VARIANTS.reduce((s, v) => s + store[v.key][20].length, 0);
  console.log(`\n==== 跑了什麼（證據）====`);
  console.log(`測試期間(訊號日): ${START} ~ ${END}（全部變體對齊同一段）`);
  console.log(`股票檔案: ${files.length} 個 | 實際處理: ${processed} 檔 | 跳過(資料不全/太短): ${skipped} 檔`);
  console.log(`期間內檢查: ${winIters.toLocaleString()} 個「檔×交易日」格子 × 11 套策略 = ${(winIters * 11).toLocaleString()} 次條件判斷（全程掃 ${iters.toLocaleString()} 格）`);
  console.log(`命中後完整結算(d20)的交易筆數合計: ${totalHits.toLocaleString()} 筆`);
  console.log(`耗時: ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

  console.log(`\n==== 籌碼選股組合大對照（扣成本 ${COST.toFixed(2)}%，vs ^TWII，全部命中）====`);
  console.log(`(按 持有20日超額 由高到低排；★=train與test都正=較可能真有料)\n`);
  console.log('變體                                n     淨均20   勝20    超額d5  d10   d20   贏大盤  train/test(d20)');
  for (const r of rows) {
    const f = (x: number, p = 5) => (Number.isFinite(x) ? x.toFixed(2) : '—').padStart(p);
    const star = r.bothPos ? ' ★' : '';
    console.log(
      `${r.v.label.padEnd(30)} ${String(r.n).padStart(5)}  ${f(r.net20, 6)}%  ${f(r.win20, 4)}%  ${f(r.e5)}% ${f(r.e10)}% ${f(r.e20)}%  ${f(r.beat, 4)}%  ${f(r.tr)}/${f(r.te)}${star}`,
    );
  }
  console.log('\n說明：超額>0 且 贏大盤>50% 且 train/test 都正(★) 才算「可能真有料」。否則多半是大盤beta或運氣。');
}
main().catch(e => { console.error(e); process.exit(1); });
