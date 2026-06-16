/**
 * 法人偷買(原) 條件②「集中度在爬」對照：是否要求集中度 > 0
 *
 * 共同：①股價在跌 ③法人連買≥2天且近5日淨買>0
 * 條件②：
 *   現行（require positive）：主力分點5日集中度 > 0 且 比5日前大、≤上限、不爆量
 *   放寬（allow negative）：  主力分點5日集中度 比5日前大、≤上限、不爆量（即使還是負的也算「慢慢回升」）
 *
 * 輸出：(1) 6691 在 2026-06-10 兩規則下的條件②判定
 *       (2) 回測 d5/d10/d20 淨報酬/勝率/超額/train-test，比較兩規則
 * 用法：npx tsx scripts/compare-inststeal-concpos.ts
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

interface Trade { date: string; entryDate: string; net: number; excess: number }

async function main() {
  const twii = readJson(TWII); const twC: RC[] = twii?.candles || twii || [];
  const twClose = new Map<string, number>(); for (const c of twC) twClose.set(c.date, c.close);

  const files = (await fs.readdir(INST_DIR)).filter(f => /^\d{4,}\.json$/.test(f));
  // STRICT = 現行(>0)  RELAX = 放寬(允許負但在爬)
  const trS: Record<number, Trade[]> = { 5: [], 10: [], 20: [] };
  const trR: Record<number, Trade[]> = { 5: [], 10: [], 20: [] };

  for (const f of files) {
    const code = f.replace('.json', '');
    const inst = readJson(path.join(INST_DIR, f)); const broker = readJson(path.join(BROKER_DIR, f));
    const cdl = readJson(path.join(CANDLE_DIR, `${code}.TW.json`));
    if (!inst || !broker || !cdl) continue;
    const cs: RC[] = (cdl.candles || []).filter((c: RC) => c.close > 0);
    if (cs.length < NEED + 25) continue;
    const bMap = new Map<string, number>(); for (const d of broker.data || []) bMap.set(d.date, d.netDifference ?? 0);
    const iMap = new Map<string, number>(); for (const d of inst.data || []) iMap.set(d.date, d.total ?? 0);

    let lastS = -99, lastR = -99;
    for (let t = NEED; t < cs.length; t++) {
      const drop = (cs[t].close / cs[t - P.dropWin].close - 1) * 100;
      const isDrop = drop < P.dropMax;
      const bC = conc(bMap, cs, t, P.concWin), bCp = conc(bMap, cs, t - P.concRiseBack, P.concWin);
      if (bC == null || bCp == null) continue;
      let v20 = 0; for (let k = t - 19; k <= t; k++) v20 += cs[k].volume || 0;
      const volR = v20 > 0 ? (cs[t].volume || 0) / (v20 / 20) : 0;
      const rising = bC > bCp && bC <= P.concCap && volR < P.volRatioMax;
      const condStrict = isDrop && rising && bC > 0;
      const condRelax = isDrop && rising;
      // ③ 法人連買
      let iSum = 0; let ok = true;
      for (let k = t - (P.instWin - 1); k <= t; k++) { if (!iMap.has(cs[k].date)) { ok = false; break; } iSum += iMap.get(cs[k].date)!; }
      let consec = 0; for (let k = t; k >= 0; k--) { if (!iMap.has(cs[k].date)) break; if ((iMap.get(cs[k].date) ?? 0) > 0) consec++; else break; }
      const condInst = ok && iSum > 0 && consec >= P.instConsecMin;

      // 6691 @ 2026-06-10 診斷
      if (code === '6691' && cs[t].date === '2026-06-10') {
        console.log(`\n--- 6691 @ 2026-06-10 條件拆解 ---`);
        console.log(`  ① 在跌  drop5=${drop.toFixed(2)}%  → ${isDrop}`);
        console.log(`  ② 集中度 ${bCp.toFixed(1)}→${bC.toFixed(1)}%  在爬=${bC > bCp} ≤上限=${bC <= P.concCap} 不爆量(${volR.toFixed(2)})=${volR < P.volRatioMax}  >0=${bC > 0}`);
        console.log(`     現行(>0)判定 ②=${rising && bC > 0}   放寬判定 ②=${rising}`);
        console.log(`  ③ 法人連買 consec=${consec} sum5=${iSum}  → ${condInst}`);
        console.log(`  ⇒ 現行命中=${condStrict && condInst}   放寬命中=${condRelax && condInst}`);
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
      if (condStrict && condInst) lastS = fwd(trS, lastS);
      if (condRelax && condInst) lastR = fwd(trR, lastR);
    }
  }

  console.log(`\n========== 回測對照（進場隔日開盤，扣成本 ${COST.toFixed(2)}%，vs ^TWII）==========`);
  for (const h of HOLD) {
    for (const [label, tr] of [['現行 ②須>0', trS[h]], ['放寬 ②可負但在爬', trR[h]]] as [string, Trade[]][]) {
      const t = tr.slice().sort((a, b) => a.entryDate.localeCompare(b.entryDate));
      if (!t.length) { console.log(`  持有${h}日 ${label}: 無交易`); continue; }
      const mid = t[t.length >> 1].entryDate;
      const ex = t.map(x => x.excess).filter(Number.isFinite);
      const exTr = t.filter(x => x.entryDate < mid).map(x => x.excess).filter(Number.isFinite);
      const exTe = t.filter(x => x.entryDate >= mid).map(x => x.excess).filter(Number.isFinite);
      const beat = ex.length ? 100 * ex.filter(x => x > 0).length / ex.length : NaN;
      console.log(`  持有${h}日 ${label.padEnd(16)}  n=${String(t.length).padStart(5)}  淨均 ${mean(t.map(x => x.net)).toFixed(2).padStart(6)}%  勝 ${winPct(t.map(x => x.net)).toFixed(1)}%  超額 ${mean(ex).toFixed(2).padStart(6)}%  贏大盤 ${beat.toFixed(1)}%  | train ${mean(exTr).toFixed(2)}% / test ${mean(exTe).toFixed(2)}%`);
    }
    console.log('');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
