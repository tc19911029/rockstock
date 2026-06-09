// ============================================================
// 三色 — 「該買 grade」細修最佳化（alpha 在 grade 不在參數 → 改搜「收緊條件」能否再榨 lift）
//
// 基底 = 該買集（combo grade top/prime＝紅在場＋雙B/捕撈觸發）。對它 AND 上各種子條件
// （黃控盤 / 三色齊 / 底反金叉 / 雙箭頭共振 / 站上MA60 / 0軸上 / 無衝突 / 量價強勢 / 三組齊發…），
// 量每個收緊版的「對**同 regime 大盤基準**的 d5 勝率 lift」。指標一律用 PRODUCTION 參數（不動）。
//
// 過擬合防護：train 段挑出「看起來好」的收緊條件，OOS 段驗證（守不住就是過擬合）；逐 regime + min-sample。
//
// 用法：npx tsx scripts/optimize-sanse-grade.ts <TW|CN>
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { computeDualB, computeXys, computeCatchVolSurge } from '@/lib/cn-sanse/dualB';
import { PRODUCTION_PARAMS } from '@/lib/cn-sanse/params';
import type { Candle } from '@/types';

type Market = 'TW' | 'CN';
type Regime = 'bull' | 'chop' | 'bear';
const FWD_WINDOW = 32, WARMUP = 480, MIN_BARS = WARMUP + FWD_WINDOW + 8, LIMIT_GAP = 0.095;
const TRAIN_FRAC = 0.65, SEED = 20260603, MIN_N = 40;
const SAMPLE: Record<Market, number> = { CN: 250, TW: 200 };
const CN_SH = '000001.SS', CN_SZ = '399001.SZ', TW_IDX = '^TWII';
const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);

function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sample<T>(arr: T[], k: number): T[] { if (arr.length <= k) return [...arr]; const r = mulberry32(SEED); const idx = arr.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } return idx.slice(0, k).map((i) => arr[i]); }
async function readRaw(dir: string, sym: string): Promise<Candle[] | null> { try { const d = JSON.parse(await fs.readFile(path.join(dir, `${sym}.json`), 'utf8')); if (!Array.isArray(d?.candles)) return null; const cs = d.candles as Candle[]; for (const c of cs) if (typeof c.date === 'string' && c.date.endsWith('*')) c.date = c.date.slice(0, -1); return cs; } catch { return null; } }
const closeMap = (cs: Candle[] | null) => { const m = new Map<string, number>(); if (cs) for (const c of cs) m.set(c.date, c.close); return m; };
async function loadUniverse(market: Market, dir: string): Promise<string[]> {
  if (market === 'TW') return (await fs.readdir(dir)).filter((f) => /^(\d{4})\.(TW|TWO)\.json$/.test(f) && !f.startsWith('00')).map((f) => f.replace(/\.json$/, ''));
  const raw = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data/cn_stocklist.json'), 'utf8'));
  const seen = new Set<string>(); const out: string[] = [];
  for (const s of (raw.stocks ?? []) as { symbol: string; name: string }[]) {
    const code = s.symbol.split('.')[0];
    if (!s.symbol || s.symbol === CN_SH || s.symbol === CN_SZ || /^(30|688|8|4)/.test(code) || s.name.includes('ST') || s.name.startsWith('*') || s.name.startsWith('S') || s.name.includes('退') || seen.has(s.symbol)) continue;
    seen.add(s.symbol); out.push(s.symbol);
  }
  return out;
}
function regimeMap(idx: Candle[]): Map<string, Regime> {
  const c = idx.map((x) => x.close); const ma = (n: number, i: number) => (i + 1 < n ? null : c.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
  const m = new Map<string, Regime>();
  for (let i = 0; i < idx.length; i++) { const m20 = ma(20, i), m60 = ma(60, i); let r: Regime = 'chop'; if (m20 != null && m60 != null) { if (c[i] > m20 && c[i] > m60) r = 'bull'; else if (c[i] < m20 && c[i] < m60) r = 'bear'; } m.set(idx[i].date, r); }
  return m;
}
interface Fwd { tradable: boolean; d5: number | null }
function forwardAt(O: number[], H: number[], L: number[], C: number[], n: number, i: number): Fwd | null {
  if (i + 1 >= n) return null; const base = O[i + 1]; if (!(base > 0)) return null;
  const locked = L[i + 1] > 0 && O[i + 1] === H[i + 1] && (H[i + 1] - L[i + 1]) / L[i + 1] < 0.005;
  const tradable = !(locked || (O[i + 1] - C[i]) / C[i] >= LIMIT_GAP);
  const d5 = i + 5 < n ? +(((C[i + 5] - base) / base) * 100).toFixed(3) : null;
  return { tradable, d5 };
}

/** 一根的條件旗標（PRODUCTION 指標）。 */
interface Flags { buy: boolean; red: boolean; purple: boolean; yellow: boolean; three: boolean; aboveMa60: boolean; xAbove: boolean; cGold: boolean; cBear: boolean; bReson: boolean; bGold: boolean; vol: boolean; noConflict: boolean; top: boolean; kpHi: boolean }
function flagsAt(s: ReturnType<typeof computeSanSe>, db: ReturnType<typeof computeDualB>, xys: ReturnType<typeof computeXys>, vol: boolean[], close: number[], i: number): Flags | null {
  const mainBuy = s.strict[i] || s.medium[i] || s.loose[i];
  const bGold = !!db.goldCross[i], bBreak = !!db.breakUp[i], cGold = !!xys.goldCross[i];
  const bBuy = bGold || bBreak, trigger = bBuy || cGold;
  const gbc = (mainBuy ? 1 : 0) + (bBuy ? 1 : 0) + (cGold ? 1 : 0);
  if (gbc < 1) return null;
  const red = r2(s.midStrength[i]) > 0, purple = r2(s.shortAttack[i]) > 0, yellow = r2(s.midControl[i]) > 0;
  const top = gbc === 3, prime = !top && red && trigger, buy = top || prime;
  if (!buy) return null;
  const x1 = xys.xys1[i];
  return {
    buy: true, red, purple, yellow, three: red && purple && yellow,
    aboveMa60: Number.isFinite(db.ma60[i]) && close[i] > db.ma60[i],
    xAbove: Number.isFinite(x1) && x1 > 0,
    cGold, cBear: cGold && Number.isFinite(x1) && x1 < 0,
    bReson: bGold && bBreak, bGold, vol: vol[i],
    noConflict: !(db.deadCross[i] || db.breakDn[i] || xys.deadCross[i]),
    top, kpHi: r2(s.kongPan[i]) > 80,
  };
}

// 收緊條件庫（base 之外各 AND 一個/兩個子條件）
const REFINES: { name: string; test: (f: Flags) => boolean }[] = [
  { name: 'base 該買(top/prime)', test: () => true },
  { name: '+黃控盤', test: (f) => f.yellow },
  { name: '+三色齊(紅紫黃)', test: (f) => f.three },
  { name: '+站上MA60', test: (f) => f.aboveMa60 },
  { name: '+動能0軸上', test: (f) => f.xAbove },
  { name: '+捕撈底反金叉', test: (f) => f.cBear },
  { name: '+捕撈任一金叉', test: (f) => f.cGold },
  { name: '+雙箭頭共振', test: (f) => f.bReson },
  { name: '+雙B金叉', test: (f) => f.bGold },
  { name: '+量價強勢', test: (f) => f.vol },
  { name: '+無衝突', test: (f) => f.noConflict },
  { name: '+三組齊發(top)', test: (f) => f.top },
  { name: '+控盤>80', test: (f) => f.kpHi },
  { name: '黃+站MA60', test: (f) => f.yellow && f.aboveMa60 },
  { name: '三色齊+無衝突', test: (f) => f.three && f.noConflict },
  { name: '底反+無衝突', test: (f) => f.cBear && f.noConflict },
  { name: 'top+無衝突', test: (f) => f.top && f.noConflict },
  { name: '黃+0軸上+無衝突', test: (f) => f.yellow && f.xAbove && f.noConflict },
];

type Seg = 'in' | 'out';
const win = (a: number[]) => (a.length ? Math.round(a.filter((x) => x > 0).length / a.length * 100) : null);
const avg = (a: number[]) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);

async function main() {
  const market = (process.argv[2] ?? '').toUpperCase() as Market;
  if (market !== 'TW' && market !== 'CN') throw new Error('用法：optimize-sanse-grade.ts <TW|CN>');
  const dir = getLocalCandleDir(market);
  const outDir = path.join(process.cwd(), 'data', market === 'TW' ? 'tw-sanse' : 'cn-sanse');
  const idxSH = await readRaw(dir, market === 'TW' ? TW_IDX : CN_SH); if (!idxSH?.length) throw new Error('找不到指數');
  const mapSH = closeMap(idxSH); const mapSZ = market === 'CN' ? closeMap(await readRaw(dir, CN_SZ)) : mapSH; const mapSZeff = mapSZ.size ? mapSZ : mapSH;
  const reg = regimeMap(idxSH); const dates = idxSH.map((c) => c.date);
  const cutLow = dates[Math.floor(dates.length * TRAIN_FRAC)];
  const cutHigh = dates[Math.min(dates.length - 1, Math.floor(dates.length * TRAIN_FRAC) + FWD_WINDOW)];
  const universe = sample(await loadUniverse(market, dir), SAMPLE[market]);

  // 累計器：refine → seg → regime|'all' → d5[]；大盤基準同結構（key 'BASELINE'）
  const acc = new Map<string, Record<Seg, Record<string, number[]>>>();
  const mk = (): Record<Seg, Record<string, number[]>> => ({ in: { all: [], bull: [], chop: [], bear: [] }, out: { all: [], bull: [], chop: [], bear: [] } });
  for (const r of REFINES) acc.set(r.name, mk());
  acc.set('BASELINE', mk());
  let used = 0;
  const BATCH = 80;
  for (let b = 0; b < universe.length; b += BATCH) {
    const loaded = await Promise.all(universe.slice(b, b + BATCH).map((s) => readRaw(dir, s)));
    universe.slice(b, b + BATCH).forEach((symbol, k) => {
      const candles = loaded[k]; if (!candles || candles.length < MIN_BARS) return;
      const O = candles.map((c) => c.open), H = candles.map((c) => c.high), L = candles.map((c) => c.low), C = candles.map((c) => c.close), n = candles.length;
      const home = market === 'CN' && symbol.endsWith('.SZ') ? mapSZeff : mapSH; let last = NaN;
      const idxClose = candles.map((c) => { const v = home.get(c.date); if (v != null) last = v; return last; });
      const s = computeSanSe(candles, idxClose, NaN, PRODUCTION_PARAMS), db = computeDualB(candles, PRODUCTION_PARAMS), xys = computeXys(candles, PRODUCTION_PARAMS), vol = computeCatchVolSurge(candles, PRODUCTION_PARAMS);
      used++;
      for (let i = WARMUP; i <= n - 1 - FWD_WINDOW; i++) {
        const date = candles[i].date; const seg: Seg | null = date < cutLow ? 'in' : date >= cutHigh ? 'out' : null;
        if (!seg) continue;
        const f = forwardAt(O, H, L, C, n, i); if (!f || !f.tradable || f.d5 == null) continue;
        const rg = reg.get(date) ?? 'chop';
        const bl = acc.get('BASELINE')![seg]; bl.all.push(f.d5); bl[rg].push(f.d5);
        const fl = flagsAt(s, db, xys, vol, C, i); if (!fl) continue;
        for (const ref of REFINES) if (ref.test(fl)) { const a = acc.get(ref.name)![seg]; a.all.push(f.d5); a[rg].push(f.d5); }
      }
    });
  }

  const blIn = acc.get('BASELINE')!.in, blOut = acc.get('BASELINE')!.out;
  const liftAll = (a: number[], blSeg: Record<string, number[]>) => { const w = win(a), bw = win(blSeg.all); return w == null || bw == null ? null : w - bw; };
  const liftRg = (a: number[], blSeg: Record<string, number[]>, rg: string) => { const w = win(a), bw = win(blSeg[rg]); return w == null || bw == null || a.length < MIN_N ? null : w - bw; };
  const ps = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}pp`);

  const baseOutLift = liftAll(acc.get('base 該買(top/prime)')!.out.all, blOut);
  const rows = REFINES.map((ref) => {
    const inA = acc.get(ref.name)!.in, outA = acc.get(ref.name)!.out;
    return {
      name: ref.name,
      trainLift: liftAll(inA.all, blIn), trainN: inA.all.length,
      oosLift: liftAll(outA.all, blOut), oosN: outA.all.length, oosAvg: avg(outA.all),
      bull: liftRg(outA.bull, blOut, 'bull'), chop: liftRg(outA.chop, blOut, 'chop'), bear: liftRg(outA.bear, blOut, 'bear'),
    };
  });
  // 依「train lift」排（模擬：在 train 上挑好的，看 OOS 守不守得住）
  const ranked = [...rows].sort((a, b) => (b.trainLift ?? -99) - (a.trainLift ?? -99));

  const L: string[] = [];
  L.push(`# 三色「該買 grade」細修 — ${market === 'TW' ? '台股' : '陸股'}（OOS ≥ ${cutHigh}，抽樣 ${used} 檔）`);
  L.push('');
  L.push(`基底 = 該買集(top/prime)；各列再 AND 一個收緊條件。lift = 該集 d5 勝率 − 同 seg/regime **大盤基準**勝率。`);
  L.push(`大盤基準勝率：train all ${win(blIn.all)}%（n${blIn.all.length}）｜OOS all ${win(blOut.all)}%（n${blOut.all.length}）。基底該買 OOS lift ${ps(baseOutLift)}。`);
  L.push(`**讀法**：train lift 高 = 在訓練段看起來好；要 **OOS lift 也 ≥ 基底且為正、且 ≥2 regime 不崩** 才算真有用（否則過擬合）。n<${MIN_N} 的 regime 不判定（—）。`);
  L.push('');
  L.push('| 收緊條件 | train lift(n) | **OOS lift**(n) | OOS avg | OOS bull | OOS chop | OOS bear | 守得住? |');
  L.push('|---|---|---|---|---|---|---|:--:|');
  for (const r of ranked) {
    const beatsBase = r.oosLift != null && baseOutLift != null && r.oosLift > baseOutLift && r.oosLift > 0;
    const regimesOK = [r.bull, r.chop, r.bear].filter((x) => x != null && x > 0).length;
    const held = r.name.startsWith('base') ? '基底' : (beatsBase && regimesOK >= 2 ? '✅' : r.oosN < MIN_N ? '樣本少' : '❌');
    L.push(`| ${r.name} | ${ps(r.trainLift)}(${r.trainN}) | **${ps(r.oosLift)}**(${r.oosN}) | ${r.oosAvg == null ? '—' : `${r.oosAvg > 0 ? '+' : ''}${r.oosAvg}%`} | ${ps(r.bull)} | ${ps(r.chop)} | ${ps(r.bear)} | ${held} |`);
  }
  L.push('');
  L.push('> ✅=OOS lift 贏基底+為正+≥2 regime 撐住（值得收緊）；❌=OOS 沒守住（過擬合/無用）；樣本少=OOS 不足判定。');
  const md = L.join('\n');
  await fs.writeFile(path.join(outDir, `grade-refine-${market}.md`), md, 'utf8');
  console.log('\n' + md);
}
main().catch((e) => { console.error(e); process.exit(1); });
