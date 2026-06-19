/**
 * 法人偷買(原) 第三條件鬆綁對照：A=法人連買≥2天 vs C=只要5日淨買>0
 *
 * 共同：①股價在跌 ②5日主力分點集中度在爬（>0 且比5日前大、不爆量、≤上限）
 * 第三條：
 *   A（現行 Y）：三大法人近5日淨買>0 且 連買≥2天
 *   C（鬆綁）  ：三大法人近5日淨買>0（不要求連買）
 *
 * 目的：使用者問「要不要把法人連買改成5日買進數量為正數就行」。看鬆綁後事後報酬有沒有掉。
 * 用法：npx tsx scripts/compare-inststeal-consec.ts
 */
import { promises as fs } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { FEE_RATES } from '../lib/portfolio/fees';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER_DIR = path.join(process.cwd(), 'data/chips/TW/broker');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');

const P = { dropWin: 5, dropMax: -2, concWin: 5, concRiseBack: 5, concCap: 12, volRatioMax: 2, instWin: 5, instConsecMin: 2 };
const NEED = Math.max(P.concWin + P.concRiseBack, 20, P.dropWin, P.instWin);
const COST = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100;
const HOLD = [5, 10, 20];
const COOLDOWN = 5;

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
  const trA: Record<number, Trade[]> = { 5: [], 10: [], 20: [] };
  const trC: Record<number, Trade[]> = { 5: [], 10: [], 20: [] };
  // 「只在 C 命中、A 沒中」的那批（鬆綁多撈進來的）單獨統計，看品質
  const trOnlyC: Record<number, Trade[]> = { 5: [], 10: [], 20: [] };

  for (const f of files) {
    const code = f.replace('.json', '');
    const inst = readJson(path.join(INST_DIR, f)); const broker = readJson(path.join(BROKER_DIR, f));
    const cdl = readJson(path.join(CANDLE_DIR, `${code}.TW.json`));
    if (!inst || !broker || !cdl) continue;
    const cs: RC[] = (cdl.candles || []).filter((c: RC) => c.close > 0);
    if (cs.length < NEED + 25) continue;
    const bMap = new Map<string, number>(); for (const d of broker.data || []) bMap.set(d.date, d.netDifference ?? 0);
    const iMap = new Map<string, number>(); for (const d of inst.data || []) iMap.set(d.date, d.total ?? 0);

    let lastA = -99, lastC = -99, lastOnlyC = -99;
    for (let t = NEED; t < cs.length; t++) {
      const drop = (cs[t].close / cs[t - P.dropWin].close - 1) * 100;
      if (!(drop < P.dropMax)) continue;
      const bC = conc(bMap, cs, t, P.concWin), bCp = conc(bMap, cs, t - P.concRiseBack, P.concWin);
      if (bC == null || bCp == null) continue;
      let v20 = 0; for (let k = t - 19; k <= t; k++) v20 += cs[k].volume || 0;
      const volR = v20 > 0 ? (cs[t].volume || 0) / (v20 / 20) : 0;
      const brokerRising = bC > 0 && bC > bCp && bC <= P.concCap && volR < P.volRatioMax;
      if (!brokerRising) continue;
      let iSum = 0; let ok = true;
      for (let k = t - (P.instWin - 1); k <= t; k++) { if (!iMap.has(cs[k].date)) { ok = false; break; } iSum += iMap.get(cs[k].date)!; }
      if (!ok) continue;
      let consec = 0; for (let k = t; k >= 0; k--) { if (!iMap.has(cs[k].date)) break; if ((iMap.get(cs[k].date) ?? 0) > 0) consec++; else break; }

      const condA = iSum > 0 && consec >= P.instConsecMin;
      const condC = iSum > 0;                  // 鬆綁版
      const onlyC = condC && !condA;           // 鬆綁才多撈的

      const fwd = (recur: Record<number, Trade[]>, last: number): number => {
        if (t - last <= COOLDOWN) return last;
        const entry = cs[t + 1]; if (!entry || !(entry.open > 0)) return last;
        if (entry.open === entry.high && entry.low > 0 && (entry.high - entry.low) / entry.low < 0.005) return last; // 一字鎖
        if (Math.abs(entry.open / cs[t].close - 1) > 0.25) return last;
        for (const h of HOLD) {
          const ex = cs[t + 1 + h]; if (!ex || !(ex.close > 0)) continue;
          const net = (ex.close / entry.open - 1) * 100 - COST;
          const tw0 = twClose.get(entry.date), tw1 = twClose.get(ex.date);
          const idx = tw0 && tw1 ? (tw1 / tw0 - 1) * 100 : NaN;
          recur[h].push({ entryDate: entry.date, net, excess: Number.isFinite(idx) ? net - idx : NaN });
        }
        return t;
      };
      if (condA) lastA = fwd(trA, lastA);
      if (condC) lastC = fwd(trC, lastC);
      if (onlyC) lastOnlyC = fwd(trOnlyC, lastOnlyC);
    }
  }

  console.log(`\n========== 法人連買 vs 5日淨買正 回測對照 ==========`);
  console.log(`進場=訊號隔日開盤，扣成本 ${COST.toFixed(2)}%，超額 vs ^TWII，train/test 各半（時間切半）`);
  console.log(`A=現行(連買≥2天)  C=鬆綁(只要5日淨買>0)  onlyC=鬆綁才多撈的那批\n`);
  for (const h of HOLD) {
    console.log(`── 持有 ${h} 日 ──`);
    for (const [label, tr] of [['A 連買≥2天', trA[h]], ['C 5日淨買>0', trC[h]], ['  └ onlyC 多撈批', trOnlyC[h]]] as [string, Trade[]][]) {
      const t = tr.slice().sort((a, b) => a.entryDate.localeCompare(b.entryDate));
      if (!t.length) { console.log(`  ${label.padEnd(14)} 無交易`); continue; }
      const mid = t[t.length >> 1].entryDate;
      const ex = t.map(x => x.excess).filter(Number.isFinite);
      const exTr = t.filter(x => x.entryDate < mid).map(x => x.excess).filter(Number.isFinite);
      const exTe = t.filter(x => x.entryDate >= mid).map(x => x.excess).filter(Number.isFinite);
      const beat = ex.length ? 100 * ex.filter(x => x > 0).length / ex.length : NaN;
      console.log(`  ${label.padEnd(14)} n=${String(t.length).padStart(5)}  淨均 ${mean(t.map(x => x.net)).toFixed(2).padStart(6)}%  勝 ${winPct(t.map(x => x.net)).toFixed(1).padStart(5)}%  超額 ${mean(ex).toFixed(2).padStart(6)}%  贏大盤 ${beat.toFixed(1).padStart(5)}%  | train ${mean(exTr).toFixed(2).padStart(6)}% / test ${mean(exTe).toFixed(2).padStart(6)}%`);
    }
    console.log('');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
