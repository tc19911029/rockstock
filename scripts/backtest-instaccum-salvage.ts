/**
 * 「法人吸·融資退」搶救回測 — 基準版全負，試各種「技術進場點」疊加能否翻正。
 *
 * 籌碼底（固定）：法人大買（5日淨買超>0 且 連買≥2）+ 融資5日變化。
 * 疊加變體（看哪個 train/test 都正才有救）：
 *   A 沒大漲(基準·控制組)        — 融資減 + 漲幅∈[-10,5]
 *   B +站上MA20                 — 融資減 + close>MA20
 *   C +突破20日新高(真進場依據)   — 融資減 + close>前20日最高
 *   D +MACD柱翻紅               — 融資減 + hist翻正
 *   E +KD金叉                   — 融資減 + K上穿D
 *   F 融資大「增」+沒大漲(反向假設) — 融資增≥+3% + 漲幅∈[-10,5]
 *   G 籌碼底+剛起漲(+2~+10%)     — 融資減 + 漲幅∈[2,10]（不是買盤整、是買剛發動）
 *
 * 進場=隔日開盤，持有{5,10,20}收盤，扣成本，vs ^TWII 超額，train/test 中點切。
 * |報酬|>80% 視為停牌/資料異常剔除（同 factor-grid-search 慣例）。
 * 用法：npx tsx scripts/backtest-instaccum-salvage.ts
 */
import { promises as fs } from 'fs';
import path from 'path';
import { FEE_RATES } from '../lib/portfolio/fees';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const MARGIN_DIR = path.join(process.cwd(), 'data/chips/TW/margin');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');
const COST = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100;
const HOLDS = [5, 10, 20];

interface C { date: string; open: number; high: number; low: number; close: number; volume: number }
function readJson(p: string): any | null { try { return JSON.parse(require('fs').readFileSync(p, 'utf8')); } catch { return null; } }
function ema(arr: number[], n: number): number[] { const k = 2 / (n + 1); const out: number[] = []; let prev = arr[0] ?? 0; for (let i = 0; i < arr.length; i++) { prev = i === 0 ? (arr[0] ?? 0) : arr[i] * k + prev * (1 - k); out.push(prev); } return out; }
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const winPct = (xs: number[]) => xs.length ? 100 * xs.filter(x => x > 0).length / xs.length : NaN;

interface T { date: string; excess: number; }

async function main() {
  const twiiRaw = readJson(TWII); const twiiC: C[] = twiiRaw?.candles || twiiRaw || [];
  const twii = new Map<string, number>(); for (const c of twiiC) twii.set(c.date, c.close);
  const files = (await fs.readdir(INST_DIR)).filter(f => /^\d{4,}\.json$/.test(f));

  const VARIANTS = ['A 沒大漲(控制)', 'B +站上MA20', 'C +突破20日高', 'D +MACD翻紅', 'E +KD金叉', 'F 融資增+沒大漲', 'G 籌碼底+剛起漲'];
  const buckets: Record<string, Record<number, T[]>> = {};
  for (const v of VARIANTS) buckets[v] = { 5: [], 10: [], 20: [] };
  let loaded = 0;

  for (const f of files) {
    const code = f.replace('.json', '');
    const inst = readJson(path.join(INST_DIR, f)); const margin = readJson(path.join(MARGIN_DIR, f));
    const cdl = readJson(path.join(CANDLE_DIR, `${code}.TW.json`)) || readJson(path.join(CANDLE_DIR, `${code}.TWO.json`));
    if (!inst || !margin || !cdl) continue;
    const cs: C[] = (cdl.candles || []).filter((c: C) => c.close > 0);
    if (cs.length < 60) continue;
    loaded++;
    const im = new Map<string, number>(); for (const d of inst.data || []) im.set(d.date, d.total ?? 0);
    const mm = new Map<string, number>(); for (const d of margin.data || []) mm.set(d.date, d.marginBalance ?? 0);
    const closes = cs.map(c => c.close);
    const e12 = ema(closes, 12), e26 = ema(closes, 26);
    const macd = closes.map((_, i) => e12[i] - e26[i]); const sig = ema(macd, 9);
    const hist = macd.map((m, i) => m - sig[i]);
    const K: number[] = [], D: number[] = [];
    for (let i = 0; i < cs.length; i++) {
      let lo = Infinity, hi = -Infinity;
      for (let j = Math.max(0, i - 8); j <= i; j++) { if (cs[j].low < lo) lo = cs[j].low; if (cs[j].high > hi) hi = cs[j].high; }
      const rsv = hi > lo ? (cs[i].close - lo) / (hi - lo) * 100 : 50;
      K[i] = i === 0 ? 50 : K[i - 1] * 2 / 3 + rsv / 3;
      D[i] = i === 0 ? 50 : D[i - 1] * 2 / 3 + K[i] / 3;
    }

    for (let t = 26; t < cs.length - 1; t++) {
      // 法人大買（5日淨買超>0 且 連買≥2）
      let inst5 = 0, ok = true;
      for (let k = t - 4; k <= t; k++) { if (!im.has(cs[k].date)) { ok = false; break; } inst5 += im.get(cs[k].date)!; }
      if (!ok || inst5 <= 0) continue;
      let consec = 0; for (let k = t; k >= 0; k--) { if (!im.has(cs[k].date)) break; if ((im.get(cs[k].date) ?? 0) > 0) consec++; else break; }
      if (consec < 2) continue;
      // 融資5日變化
      const mT = mm.get(cs[t].date), mW = mm.get(cs[t - 5].date);
      if (mT == null || mW == null || !(mW > 0)) continue;
      const marginChg = (mT / mW - 1) * 100;
      const marginDrop = marginChg <= -3, marginRise = marginChg >= 3;

      const chg5 = (cs[t].close / cs[t - 5].close - 1) * 100;
      let m20 = 0; for (let k = t - 19; k <= t; k++) m20 += cs[k].close; m20 /= 20;
      let hi20 = -Infinity; for (let k = t - 20; k <= t - 1; k++) if (cs[k].high > hi20) hi20 = cs[k].high;
      const flat = chg5 >= -10 && chg5 <= 5;

      const hits: Record<string, boolean> = {
        'A 沒大漲(控制)': marginDrop && flat,
        'B +站上MA20': marginDrop && cs[t].close > m20,
        'C +突破20日高': marginDrop && cs[t].close > hi20,
        'D +MACD翻紅': marginDrop && hist[t] > 0 && hist[t - 1] <= 0,
        'E +KD金叉': marginDrop && K[t] > D[t] && K[t - 1] <= D[t - 1],
        'F 融資增+沒大漲': marginRise && flat,
        'G 籌碼底+剛起漲': marginDrop && chg5 >= 2 && chg5 <= 10,
      };
      if (!Object.values(hits).some(Boolean)) continue;

      const entry = cs[t + 1];
      if (!(entry?.open > 0)) continue;
      if (entry.open === entry.high && entry.low > 0 && (entry.high - entry.low) / entry.low < 0.005) continue;
      if (cs[t].close > 0 && Math.abs(entry.open / cs[t].close - 1) > 0.25) continue;

      for (const h of HOLDS) {
        const ex = cs[t + 1 + h]; if (!ex || !(ex.close > 0)) continue;
        const net = (ex.close / entry.open - 1) * 100 - COST;
        if (Math.abs(net) > 80) continue;
        const t0 = twii.get(entry.date), t1 = twii.get(ex.date);
        if (!t0 || !t1) continue;
        const excess = net - (t1 / t0 - 1) * 100;
        for (const v of VARIANTS) if (hits[v]) buckets[v][h].push({ date: entry.date, excess });
      }
    }
  }

  console.log(`載入 ${loaded} 檔｜成本 ${COST.toFixed(2)}%　|　籌碼底=法人5日買超>0且連買≥2`);
  console.log(`目標：train 與 test 都正、贏大盤>50% 才算有救\n`);
  for (const v of VARIANTS) {
    console.log(`========== ${v} ==========`);
    for (const h of HOLDS) {
      const tr = buckets[v][h].sort((a, b) => a.date.localeCompare(b.date));
      if (tr.length < 60) { console.log(`  持有${h}日: 樣本不足(${tr.length})`); continue; }
      const mid = tr[Math.floor(tr.length / 2)].date;
      const train = tr.filter(x => x.date < mid).map(x => x.excess);
      const test = tr.filter(x => x.date >= mid).map(x => x.excess);
      const all = tr.map(x => x.excess);
      const tag = mean(train) > 0 && mean(test) > 0 ? '✅✅都正(有救?)' : mean(train) < 0 && mean(test) < 0 ? '🚫都負' : '⚠️不一致';
      console.log(`  持有${h}日 n=${String(tr.length).padStart(5)} 超額 ${mean(all).toFixed(2).padStart(6)}% 贏大盤 ${winPct(all).toFixed(1)}% | train ${mean(train).toFixed(2)}% / test ${mean(test).toFixed(2)}% → ${tag}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
