/**
 * 法人偷買(原) Y：刪掉「爆量過濾(volRatioMax)」和「集中度上限(concCap)」的影響對照。
 *
 * 共同（與現行一致）：①近5日跌>2% ②集中度比5日前高（concRequirePositive=false：負但回升也算）
 *   ③法人連買≥2天且近5日淨買>0。差別只在 ② 的兩個過濾留不留。
 * 回測：進場隔日開盤、扣成本、vs ^TWII、d5/d10/d20、train/test、每檔 cooldown 5 日。
 * ⚠️ 集中度用「舊式 Σ主力淨/Σ量」近似（全宇宙×多年無法用 FinMind）；看的是「刪過濾的相對影響」。
 * 用法：npx tsx scripts/compare-inststeal-filters.ts
 */
import { promises as fs } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { FEE_RATES } from '../lib/portfolio/fees';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER_DIR = path.join(process.cwd(), 'data/chips/TW/broker');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');

const BASE = { dropWin: 5, dropMax: -2, concWin: 5, concRiseBack: 5, instWin: 5, instConsecMin: 2 };
const NEED = Math.max(BASE.concWin + BASE.concRiseBack, 20, BASE.dropWin, BASE.instWin);
const COST = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100;
const HOLD = [5, 10, 20];
const COOLDOWN = 5;

const VARIANTS = [
  { key: 'base', label: '現行(量比<2 ＋ 集中≤12)', volRatioMax: 2, concCap: 12 },
  { key: 'novol', label: '刪爆量過濾(只留集中≤12)', volRatioMax: Infinity, concCap: 12 },
  { key: 'nocap', label: '刪集中上限(只留量比<2)', volRatioMax: 2, concCap: Infinity },
  { key: 'neither', label: '兩個都刪', volRatioMax: Infinity, concCap: Infinity },
];

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
interface Trade { entryDate: string; net: number; excess: number }

async function main() {
  const twii = readJson(TWII); const twC: RC[] = twii?.candles || twii || [];
  const twClose = new Map<string, number>(); for (const c of twC) twClose.set(c.date, c.close);
  const files = (await fs.readdir(INST_DIR)).filter(f => /^\d{4,}\.json$/.test(f));

  const trades: Record<string, Record<number, Trade[]>> = {};
  for (const v of VARIANTS) trades[v.key] = { 5: [], 10: [], 20: [] };

  for (const f of files) {
    const code = f.replace('.json', '');
    const inst = readJson(path.join(INST_DIR, f)); const broker = readJson(path.join(BROKER_DIR, f));
    const cdl = readJson(path.join(CANDLE_DIR, `${code}.TW.json`)) ?? readJson(path.join(CANDLE_DIR, `${code}.TWO.json`));
    if (!inst || !broker || !cdl) continue;
    const cs: RC[] = (cdl.candles || []).filter((c: RC) => c.close > 0);
    if (cs.length < NEED + 25) continue;
    const bMap = new Map<string, number>(); for (const d of broker.data || []) bMap.set(d.date, d.netDifference ?? 0);
    const iMap = new Map<string, number>(); for (const d of inst.data || []) iMap.set(d.date, d.total ?? 0);

    const last: Record<string, number> = {}; for (const v of VARIANTS) last[v.key] = -99;
    for (let t = NEED; t < cs.length; t++) {
      const drop = (cs[t].close / cs[t - BASE.dropWin].close - 1) * 100;
      const isDrop = drop < BASE.dropMax;
      if (!isDrop) continue;
      const bC = conc(bMap, cs, t, BASE.concWin), bCp = conc(bMap, cs, t - BASE.concRiseBack, BASE.concWin);
      if (bC == null || bCp == null) continue;
      let v20 = 0; for (let k = t - 19; k <= t; k++) v20 += cs[k].volume || 0;
      const volR = v20 > 0 ? (cs[t].volume || 0) / (v20 / 20) : 0;
      // ③ 法人連買
      let iSum = 0, ok = true;
      for (let k = t - (BASE.instWin - 1); k <= t; k++) { if (!iMap.has(cs[k].date)) { ok = false; break; } iSum += iMap.get(cs[k].date)!; }
      let consec = 0; for (let k = t; k >= 0; k--) { if (!iMap.has(cs[k].date)) break; if ((iMap.get(cs[k].date) ?? 0) > 0) consec++; else break; }
      const condInst = ok && iSum > 0 && consec >= BASE.instConsecMin;
      if (!condInst) continue;
      const baseRising = bC > bCp; // concRequirePositive=false：不要求 >0

      for (const v of VARIANTS) {
        const hit = baseRising && bC <= v.concCap && volR < v.volRatioMax;
        if (!hit) continue;
        if (t - last[v.key] <= COOLDOWN) continue;
        const entry = cs[t + 1]; if (!entry || !(entry.open > 0)) continue;
        if (entry.open === entry.high && entry.low > 0 && (entry.high - entry.low) / entry.low < 0.005) continue; // 一字鎖
        if (Math.abs(entry.open / cs[t].close - 1) > 0.25) continue;
        last[v.key] = t;
        for (const h of HOLD) {
          const ex = cs[t + 1 + h]; if (!ex || !(ex.close > 0)) continue;
          const net = (ex.close / entry.open - 1) * 100 - COST;
          const tw0 = twClose.get(entry.date), tw1 = twClose.get(ex.date);
          const idx = tw0 && tw1 ? (tw1 / tw0 - 1) * 100 : NaN;
          trades[v.key][h].push({ entryDate: entry.date, net, excess: Number.isFinite(idx) ? net - idx : NaN });
        }
      }
    }
  }

  console.log(`\n===== 刪過濾對照（進場隔日開盤，扣成本 ${COST.toFixed(2)}%，vs ^TWII）=====`);
  for (const h of HOLD) {
    console.log(`\n  ── 持有 ${h} 日 ──`);
    for (const v of VARIANTS) {
      const t = trades[v.key][h].slice().sort((a, b) => a.entryDate.localeCompare(b.entryDate));
      if (!t.length) { console.log(`    ${v.label}: 無交易`); continue; }
      const mid = t[t.length >> 1].entryDate;
      const ex = t.map(x => x.excess).filter(Number.isFinite);
      const exTr = t.filter(x => x.entryDate < mid).map(x => x.excess).filter(Number.isFinite);
      const exTe = t.filter(x => x.entryDate >= mid).map(x => x.excess).filter(Number.isFinite);
      const beat = ex.length ? 100 * ex.filter(x => x > 0).length / ex.length : NaN;
      console.log(`    ${v.label.padEnd(22)} n=${String(t.length).padStart(5)}  超額 ${mean(ex).toFixed(2).padStart(6)}%  贏大盤 ${beat.toFixed(1).padStart(5)}%  | train ${mean(exTr).toFixed(2).padStart(6)}% / test ${mean(exTe).toFixed(2).padStart(6)}%`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
