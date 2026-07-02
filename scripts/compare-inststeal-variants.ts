/**
 * 法人偷買(原) 第三條件對照：A=法人連買 vs B=法人集中度在爬
 *
 * 共同：①股價在跌 ②5日主力分點集中度在爬（>0 且比5日前大、不爆量、≤上限）
 * 第三條：
 *   A（現行 Y）：三大法人近5日淨買>0 且 連買≥2天
 *   B（新變體）：三大法人5日集中度 >0 且 比5日前大（持續變大，非翻正那一刻）
 *
 * 輸出：(1) 最新交易日 A/B 各選哪些股 + 重疊  (2) 回測 d5/d10/d20 淨報酬/勝率/超額/train-test
 * 用法：npx tsx scripts/compare-inststeal-variants.ts
 */
import { promises as fs } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { FEE_RATES } from '../lib/portfolio/fees';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER_DIR = path.join(process.cwd(), 'data/chips/TW/broker');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');
const NAMES = path.join(process.cwd(), 'data/youtube/stock-master.json');

const P = { dropWin: 5, dropMax: -2, concWin: 5, concRiseBack: 5, concCap: 12, volRatioMax: 2, instWin: 5, instConsecMin: 2 };
const NEED = Math.max(P.concWin + P.concRiseBack, 20, P.dropWin, P.instWin);
const COST = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100;
const HOLD = [5, 10, 20];
const COOLDOWN = 5;

function readJson(p: string): any | null { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
function median(xs: number[]) { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
const winPct = (xs: number[]) => xs.length ? 100 * xs.filter(x => x > 0).length / xs.length : NaN;

interface RC { date: string; open: number; high: number; low: number; close: number; volume: number }
// 結束於 t、長度 w 的集中度% = Σ(map 淨買) ÷ Σ(成交量) × 100
function conc(map: Map<string, number>, cs: RC[], t: number, w: number): number | null {
  if (t - w + 1 < 0) return null;
  let n = 0, v = 0;
  for (let k = t - w + 1; k <= t; k++) { if (!map.has(cs[k].date)) return null; n += map.get(cs[k].date)!; v += cs[k].volume || 0; }
  return v > 0 ? n / v * 100 : null;
}

interface Trade { date: string; entryDate: string; net: number; excess: number }

async function main() {
  const twii = readJson(TWII); const twC: RC[] = twii?.candles || twii || [];
  const twClose = new Map<string, number>(); for (const c of twC) twClose.set(c.date, c.close);
  const latest = twC.length ? twC[twC.length - 1].date : '';

  const names = new Map<string, string>();
  try { for (const e of (readJson(NAMES)?.entries || [])) names.set(e.code, e.name); } catch {}

  const files = (await fs.readdir(INST_DIR)).filter(f => /^\d{4,}\.json$/.test(f));
  const tradesA: Record<number, Trade[]> = { 5: [], 10: [], 20: [] };
  const tradesB: Record<number, Trade[]> = { 5: [], 10: [], 20: [] };
  const latestA: { code: string; name: string; iConc: number; consec: number }[] = [];
  const latestB: { code: string; name: string; iConc: number; iConcPrev: number }[] = [];

  for (const f of files) {
    const code = f.replace('.json', '');
    const inst = readJson(path.join(INST_DIR, f)); const broker = readJson(path.join(BROKER_DIR, f));
    const cdl = readJson(path.join(CANDLE_DIR, `${code}.TW.json`));
    if (!inst || !broker || !cdl) continue;
    const cs: RC[] = (cdl.candles || []).filter((c: RC) => c.close > 0);
    if (cs.length < NEED + 25) continue;
    const bMap = new Map<string, number>(); for (const d of broker.data || []) bMap.set(d.date, d.netDifference ?? 0);
    const iMap = new Map<string, number>(); for (const d of inst.data || []) iMap.set(d.date, d.total ?? 0);

    let lastA = -99, lastB = -99;
    for (let t = NEED; t < cs.length; t++) {
      // ① 在跌
      const drop = (cs[t].close / cs[t - P.dropWin].close - 1) * 100;
      if (!(drop < P.dropMax)) continue;
      // ② 主力分點集中度在爬
      const bC = conc(bMap, cs, t, P.concWin), bCp = conc(bMap, cs, t - P.concRiseBack, P.concWin);
      if (bC == null || bCp == null) continue;
      let v20 = 0; for (let k = t - 19; k <= t; k++) v20 += cs[k].volume || 0;
      const volR = v20 > 0 ? (cs[t].volume || 0) / (v20 / 20) : 0;
      const brokerRising = bC > 0 && bC > bCp && bC <= P.concCap && volR < P.volRatioMax;
      if (!brokerRising) continue;
      // 第三條件 A：法人連買
      let iSum = 0; let ok = true;
      for (let k = t - (P.instWin - 1); k <= t; k++) { if (!iMap.has(cs[k].date)) { ok = false; break; } iSum += iMap.get(cs[k].date)!; }
      if (!ok) continue;
      let consec = 0; for (let k = t; k >= 0; k--) { if (!iMap.has(cs[k].date)) break; if ((iMap.get(cs[k].date) ?? 0) > 0) consec++; else break; }
      const condA = iSum > 0 && consec >= P.instConsecMin;
      // 第三條件 B：法人集中度在爬
      const iC = conc(iMap, cs, t, P.concWin), iCp = conc(iMap, cs, t - P.concRiseBack, P.concWin);
      if (iC == null || iCp == null) continue;
      const condB = iC > 0 && iC > iCp && iC <= P.concCap;

      if (cs[t].date === latest) {
        if (condA) latestA.push({ code, name: names.get(code) || code, iConc: +iC.toFixed(1), consec });
        if (condB) latestB.push({ code, name: names.get(code) || code, iConc: +iC.toFixed(1), iConcPrev: +iCp.toFixed(1) });
      }

      const fwd = (recur: Record<number, Trade[]>, last: number): number => {
        if (t - last <= COOLDOWN) return last;
        const entry = cs[t + 1]; if (!entry || !(entry.open > 0)) return last;
        if (entry.open === entry.high && entry.low > 0 && (entry.high - entry.low) / entry.low < 0.005) return last;
        if (Math.abs(entry.open / cs[t].close - 1) > 0.25) return last;
        for (const h of HOLD) {
          const ex = cs[t + 1 + h]; if (!ex || !(ex.close > 0)) continue;
          const net = (ex.close / entry.open - 1) * 100 - COST;
          const tw0 = twClose.get(entry.date), tw1 = twClose.get(ex.date);
          const idx = tw0 && tw1 ? (tw1 / tw0 - 1) * 100 : NaN;
          recur[h].push({ date: cs[t].date, entryDate: entry.date, net, excess: Number.isFinite(idx) ? net - idx : NaN });
        }
        return t;
      };
      if (condA) lastA = fwd(tradesA, lastA);
      if (condB) lastB = fwd(tradesB, lastB);
    }
  }

  // (1) 最新交易日清單
  console.log(`\n========== 最新交易日 ${latest} 選股對照 ==========`);
  latestA.sort((a, b) => b.consec - a.consec);
  latestB.sort((a, b) => b.iConc - a.iConc);
  console.log(`\nA 版（法人連買）命中 ${latestA.length} 檔：`);
  console.log('  ' + latestA.slice(0, 15).map(x => `${x.code}${x.name}(連${x.consec}天)`).join('  '));
  console.log(`\nB 版（法人集中度爬）命中 ${latestB.length} 檔：`);
  console.log('  ' + latestB.slice(0, 15).map(x => `${x.code}${x.name}(法人集中${x.iConcPrev}→${x.iConc}%)`).join('  '));
  const aSet = new Set(latestA.map(x => x.code)), bSet = new Set(latestB.map(x => x.code));
  const both = [...aSet].filter(c => bSet.has(c));
  console.log(`\n兩版都選到：${both.length ? both.join(' ') : '（0）'}  | 重疊 ${both.length}/${Math.min(aSet.size, bSet.size) || 0}`);

  // (2) 回測對照
  console.log(`\n========== 回測對照（進場隔日開盤，扣成本 ${COST.toFixed(2)}%，vs ^TWII）==========`);
  for (const h of HOLD) {
    for (const [label, tr] of [['A 法人連買', tradesA[h]], ['B 法人集中度爬', tradesB[h]]] as [string, Trade[]][]) {
      const t = tr.slice().sort((a, b) => a.entryDate.localeCompare(b.entryDate));
      if (!t.length) { console.log(`  持有${h}日 ${label}: 無交易`); continue; }
      const mid = t[t.length >> 1].entryDate;
      const ex = t.map(x => x.excess).filter(Number.isFinite);
      const exTr = t.filter(x => x.entryDate < mid).map(x => x.excess).filter(Number.isFinite);
      const exTe = t.filter(x => x.entryDate >= mid).map(x => x.excess).filter(Number.isFinite);
      const beat = ex.length ? 100 * ex.filter(x => x > 0).length / ex.length : NaN;
      console.log(`  持有${h}日 ${label.padEnd(14)}  n=${String(t.length).padStart(5)}  淨均 ${mean(t.map(x => x.net)).toFixed(2).padStart(6)}%  勝 ${winPct(t.map(x => x.net)).toFixed(1)}%  超額 ${mean(ex).toFixed(2).padStart(6)}%  贏大盤 ${beat.toFixed(1)}%  | train ${mean(exTr).toFixed(2)}% / test ${mean(exTe).toFixed(2)}%`);
    }
    console.log('');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
