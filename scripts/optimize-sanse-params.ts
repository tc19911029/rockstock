// ============================================================
// 三色資金 — 逐市場「全參數搜尋」最佳化（研究/報告用，REPORT-ONLY，不接 production）
//
// 目的：三個指標（雙B / 主力狀態F / 捕撈季節）的魔術數字全是用陸股調出來的；逐市場（TW/CN）
//   以「短線 3–5 日 forward 報酬、勝率優先」當目標函數，分階段 coordinate descent 搜最佳參數，
//   產 production vs 最佳化版的對照報告（含 in-sample/out-of-sample 過擬合差距 + 逐 regime + 彩柱研究）。
//
// 方法（為什麼這樣寫）：
//   - 評估器照 research-sanse-combo.ts：每檔載一次、記憶體 walk-forward、**零 API**。
//   - forward 報酬與參數無關 → 整段 hoist 到搜尋迴圈外、每檔只算一次（最大效能槓桿）。
//   - 目標 pick 集＝combo grade ∈ {top, prime}（＝「該買」訊號；三個指標都影響它：
//       主力→redOn/池、雙B/捕撈→trigger/三組齊發。若只取「池(mainforce)」則雙B參數完全不影響選股）。
//   - 勝率優先用「字典序硬閘」：n<MIN_SAMPLES 或 avg_d5<0 → -Infinity（擋退化解），再 blend。
//   - 過擬合防護：時間切分 train0.65/OOS0.35 + 32根 embargo；報 IS/OOS 兩段 + production 同窗 baseline + 逐 regime。
//   - scale 乘數（slopeMult/ms.mult/kp.mult）凍結（與門檻冗餘，凍結省自由度且報告同軸）。
//
// ⚠️ 三色是自創因子（鐵則 #5/#10）。本腳本只產報告、不改 production 掃描/走圖/cron，
//    最佳化參數寫進 data/{cn,tw}-sanse/optimize-result-*.json，是否 promote 由使用者看完報告決定。
//
// 用法：npx tsx scripts/optimize-sanse-params.ts <TW|CN> [sampleN] [passes]
//   （selection 搜尋零 API；彩柱研究會抓「每檔一個股數常數」，快取到 shares-cache.json）
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { computeDualB, computeXys, computeTiers } from '@/lib/cn-sanse/dualB';
import { EMA, div, sub, mul, isNum } from '@/lib/cn-sanse/tdx';
import {
  PRODUCTION_PARAMS, cloneParams, CN_TIER_THRESHOLDS, TW_TIER_THRESHOLDS,
  type SanSeParams, type TierThresholds,
} from '@/lib/cn-sanse/params';
import { getSharesIssued } from '@/lib/datasource/FinMindClient';
import { fetchDayExtras } from '@/lib/cn-sanse/cnDayExtras';
import type { Candle } from '@/types';

type Market = 'TW' | 'CN';
type Regime = 'bull' | 'chop' | 'bear';
type Grade = 'top' | 'prime' | 'mid' | 'watch' | 'weak';

// ── 常數 ────────────────────────────────────────────────────────
const FWD_WINDOW = 32;        // forward 量測窗（交易日）＝ embargo 寬度
const WARMUP = 480;           // 進場起點（黃控盤吃 SUM(vol,480)）；固定不隨 mc.sumVol 變，確保各參數同進場集
const MIN_BARS = WARMUP + FWD_WINDOW + 8;
const LIMIT_GAP = 0.095;      // 隔日開跳空 ≥9.5% 視為追停買不到
const TRAIN_FRAC = 0.65;      // 時間切分：前 65% train、後段 OOS（中間留 embargo）
const MIN_SAMPLES = 80;       // 硬閘：池 in-sample d5 樣本下限（擋「縮到極少 picks」的退化解）
const EPS = 1e-6;
const DEFAULT_SAMPLE: Record<Market, number> = { CN: 400, TW: 300 };
const DEFAULT_PASSES = 2;
const MAX_EVALS = 600;        // kill-switch
const SEED = 20260603;

const CN_INDEX_SH = '000001.SS';
const CN_INDEX_SZ = '399001.SZ';
const TW_INDEX = '^TWII';

// ── 型別 ────────────────────────────────────────────────────────
interface Fwd { tradable: boolean; d3: number | null; d5: number | null; d10: number | null; mg: number; ml: number }
interface StockData {
  symbol: string;
  candles: Candle[];
  indexClose: number[];
  fwd: (Fwd | null)[];
  n: number;
}
interface PickRec { d3: number | null; d5: number | null; d10: number | null; mg: number; grade: Grade; pool: boolean; seg: 'in' | 'out' | 'gap'; regime: Regime }
interface LeanAcc { n: number; winD5: number; winD3: number; sumD5: number }
interface Baseline { winD5: number; winD3: number; n: number }

// ── 固定種子 PRNG（可重現抽樣，避免 coordinate descent 追雜訊）──
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededSample<T>(arr: T[], k: number, seed: number): T[] {
  if (arr.length <= k) return [...arr];
  const rnd = mulberry32(seed);
  const idx = arr.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, k).map((i) => arr[i]);
}

// ── universe / 載入 ─────────────────────────────────────────────
async function readRaw(dir: string, symbol: string): Promise<Candle[] | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${symbol}.json`), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.candles)) return null;
    const cs = data.candles as Candle[];
    for (const c of cs) if (typeof c.date === 'string' && c.date.endsWith('*')) c.date = c.date.slice(0, -1);
    return cs;
  } catch { return null; }
}
function isCommonTw(file: string): boolean {
  const m = file.match(/^(\d{4})\.(TW|TWO)\.json$/);
  return !!m && !m[1].startsWith('00');
}
function isExcludedCn(symbol: string, name: string): boolean {
  const code = symbol.split('.')[0];
  if (/^(30|688|8|4)/.test(code)) return true;
  if (name.includes('ST') || name.startsWith('*') || name.startsWith('S')) return true;
  if (name.includes('退')) return true;
  return false;
}
async function loadUniverse(market: Market, dir: string): Promise<string[]> {
  if (market === 'TW') {
    const files = await fs.readdir(dir);
    return files.filter(isCommonTw).map((f) => f.replace(/\.json$/, ''));
  }
  const raw = await fs.readFile(path.join(process.cwd(), 'data/cn_stocklist.json'), 'utf8');
  const seen = new Set<string>(); const out: string[] = [];
  for (const s of (JSON.parse(raw).stocks ?? []) as { symbol: string; name: string }[]) {
    if (!s.symbol || s.symbol === CN_INDEX_SH || s.symbol === CN_INDEX_SZ) continue;
    if (isExcludedCn(s.symbol, s.name) || seen.has(s.symbol)) continue;
    seen.add(s.symbol); out.push(s.symbol);
  }
  return out;
}
function dateToClose(cs: Candle[] | null): Map<string, number> {
  const m = new Map<string, number>(); if (cs) for (const c of cs) m.set(c.date, c.close); return m;
}

// ── forward 報酬（隔日開進場；漲停買不到 tradable=false）──────
function forwardAt(O: number[], H: number[], L: number[], C: number[], n: number, i: number): Fwd | null {
  if (i + 1 >= n) return null;
  const base = O[i + 1]; if (!(base > 0)) return null;
  const eH = H[i + 1], eL = L[i + 1], eO = O[i + 1];
  const locked = eL > 0 && eO === eH && (eH - eL) / eL < 0.005;
  const gapUp = (O[i + 1] - C[i]) / C[i];
  const tradable = !(locked || gapUp >= LIMIT_GAP);
  const cret = (k: number): number | null => { const idx = i + 1 + k; return idx < n ? +(((C[idx] - base) / base) * 100).toFixed(3) : null; };
  let mg = 0, ml = 0;
  for (let k = 0; k < FWD_WINDOW && i + 1 + k < n; k++) {
    const hi = ((H[i + 1 + k] - base) / base) * 100, lo = ((L[i + 1 + k] - base) / base) * 100;
    if (hi > mg) mg = hi; if (lo < ml) ml = lo;
  }
  return { tradable, d3: cret(2), d5: cret(4), d10: cret(9), mg: +mg.toFixed(3), ml: +ml.toFixed(3) };
}

// ── 大盤 regime（as-of 收盤 vs MA20/MA60，無 lookahead）──────────
function buildRegime(idx: Candle[]): Map<string, Regime> {
  const close = idx.map((c) => c.close);
  const ma = (nn: number, i: number) => (i + 1 < nn ? null : close.slice(i - nn + 1, i + 1).reduce((a, b) => a + b, 0) / nn);
  const m = new Map<string, Regime>();
  for (let i = 0; i < idx.length; i++) {
    const c = close[i], m20 = ma(20, i), m60 = ma(60, i);
    let r: Regime = 'chop';
    if (m20 != null && m60 != null) { if (c > m20 && c > m60) r = 'bull'; else if (c < m20 && c < m60) r = 'bear'; }
    m.set(idx[i].date, r);
  }
  return m;
}

// ── 選股核心：逐根算三組買點 + combo grade（fast，不配置 ConditionReport）──
const round2 = (x: number) => (isNum(x) ? Math.round(x * 100) / 100 : 0);
function selectionPicks(
  sd: StockData, p: SanSeParams,
  cb: (grade: Grade, pool: boolean, f: Fwd, date: string) => void,
): void {
  const { candles, indexClose, fwd, n } = sd;
  const s = computeSanSe(candles, indexClose, NaN, p);
  const db = computeDualB(candles, p);
  const xys = computeXys(candles, p);
  const hi = n - 1 - FWD_WINDOW;
  for (let i = WARMUP; i <= hi; i++) {
    const f = fwd[i];
    if (!f || !f.tradable) continue;
    const mainBuy = s.strict[i] || s.medium[i] || s.loose[i];
    const bBuy = !!(db.goldCross[i] || db.breakUp[i]);
    const cBuy = !!xys.goldCross[i];
    const gbc = (mainBuy ? 1 : 0) + (bBuy ? 1 : 0) + (cBuy ? 1 : 0);
    if (gbc < 1) continue;
    const redOn = round2(s.midStrength[i]) > 0;
    const yellowOn = round2(s.midControl[i]) > 0;
    const trigger = bBuy || cBuy;
    let grade: Grade;
    if (gbc === 3) grade = 'top';
    else if (redOn && trigger) grade = 'prime';
    else if (redOn && yellowOn) grade = 'mid';
    else if (redOn) grade = 'watch';
    else grade = 'weak';
    cb(grade, mainBuy, f, candles[i].date);
  }
}

/** 大盤基準（與參數無關 → 只算一次）：某段「所有可進場 K 棒」的 d5/d3 勝率。 */
function marketBaseline(stocks: StockData[], inSeg: (date: string) => boolean): Baseline {
  let n = 0, w5 = 0, w3 = 0;
  for (const sd of stocks) {
    const hi = sd.n - 1 - FWD_WINDOW;
    for (let i = WARMUP; i <= hi; i++) {
      const f = sd.fwd[i];
      if (!f || !f.tradable || f.d5 == null || !inSeg(sd.candles[i].date)) continue;
      n++; if (f.d5 > 0) w5++; if (f.d3 != null && f.d3 > 0) w3++;
    }
  }
  return { winD5: n ? w5 / n : 0, winD3: n ? w3 / n : 0, n };
}

// ── 目標函數（池＝mainforce.buyHit，使用者實際操作清單；勝率優先）──
//   池由 主力分數 + A11(XYS) + 牛熊/控盤閘 + 嚴/中/寬切點 共決定（搜尋面最廣）。
//   雙B/捕撈金叉是「觸發/排序」(combo grade)、不決定池成員 → 其參數對此目標無槓桿、會留在 production（誠實）。
//   用「勝率 lift＝池勝率 − 大盤基準勝率」當分數：純勝率會被「把池放大到逼近大盤(~48%)」灌水，
//   lift 讓「放大到基準」歸 0、只有真正選到贏面才得分。avgD5 當小幅 tiebreak/守不虧。
function leanScore(stocks: StockData[], p: SanSeParams, cutLow: string, base: Baseline): number {
  const acc: LeanAcc = { n: 0, winD5: 0, winD3: 0, sumD5: 0 };
  for (const sd of stocks) {
    selectionPicks(sd, p, (_grade, pool, f, date) => {
      if (date >= cutLow || !pool || f.d5 == null) return;  // train ∩ 池
      acc.n++; acc.sumD5 += f.d5; if (f.d5 > 0) acc.winD5++;
      if (f.d3 != null && f.d3 > 0) acc.winD3++;
    });
  }
  if (acc.n < MIN_SAMPLES) return -Infinity;                 // 唯一硬閘：擋縮到極少 picks 的退化解
  const liftD5 = acc.winD5 / acc.n - base.winD5;
  const liftD3 = acc.winD3 / acc.n - base.winD3;
  const avgD5 = acc.sumD5 / acc.n;
  return liftD5 + 0.5 * liftD3 + 0.02 * avgD5;
}

// ── 詳細 pick 蒐集（最終報告用：IS/OOS × buy/pool/all × grade × regime）──
function collectPicks(stocks: StockData[], p: SanSeParams, cutLow: string, cutHigh: string, regime: Map<string, Regime>): PickRec[] {
  const out: PickRec[] = [];
  for (const sd of stocks) {
    selectionPicks(sd, p, (grade, pool, f, date) => {
      const seg: PickRec['seg'] = date < cutLow ? 'in' : date >= cutHigh ? 'out' : 'gap';
      out.push({ d3: f.d3, d5: f.d5, d10: f.d10, mg: f.mg, grade, pool, seg, regime: regime.get(date) ?? 'chop' });
    });
  }
  return out;
}

// ── 統計 ────────────────────────────────────────────────────────
interface Stat { n: number; winD3: number | null; winD5: number | null; avgD3: number | null; avgD5: number | null; avgD10: number | null; avgMg: number | null }
function summarize(picks: PickRec[]): Stat {
  const d5 = picks.map((p) => p.d5).filter((x): x is number => x != null);
  const d3 = picks.map((p) => p.d3).filter((x): x is number => x != null);
  const d10 = picks.map((p) => p.d10).filter((x): x is number => x != null);
  const mg = picks.map((p) => p.mg).filter((x): x is number => x != null);
  const mean = (a: number[]) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
  const win = (a: number[]) => (a.length ? +((a.filter((x) => x > 0).length / a.length) * 100).toFixed(0) : null);
  return { n: d5.length, winD3: win(d3), winD5: win(d5), avgD3: mean(d3), avgD5: mean(d5), avgD10: mean(d10), avgMg: mean(mg) };
}
const fp = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const fw = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);

// ── 參數搜尋空間（分階段；scale 乘數凍結不在此）──
interface PSpec { group: keyof SanSeParams; key: string; values: number[] }
const STAGE_A: PSpec[] = [
  { group: 'sa', key: 'maShort', values: [3, 5, 8] },
  { group: 'sa', key: 'ma20', values: [10, 20, 30] },
  { group: 'sa', key: 'hhvClose', values: [13, 21, 34] },
  { group: 'ms', key: 'ma240', values: [200, 240, 260] },
  { group: 'ms', key: 'idxSmooth', values: [1, 3, 5, 8] },
  { group: 'mc', key: 'sumVol', values: [240, 360, 480] },
  { group: 'mc', key: 'sumVolDiv', values: [4, 6, 8, 12] },
  { group: 'mc', key: 'sumVar1', values: [10, 20, 30] },
  { group: 'mc', key: 'volMaLen', values: [10, 20, 30] },
  { group: 'mc', key: 'smaLen', values: [5, 10, 15, 20] },
];
const STAGE_B: PSpec[] = [
  { group: 'dualB', key: 'zhinengHHV', values: [8, 13, 21] },
  { group: 'dualB', key: 'zb4Span', values: [13, 20, 26] },
  { group: 'dualB', key: 'zb5Ma', values: [3, 6, 9] },
  { group: 'dualB', key: 'ma60', values: [40, 60, 80] },
  { group: 'xys', key: 'emaLen', values: [2, 3, 5] },
  { group: 'xys', key: 'slowMa', values: [2, 3, 5] },
  { group: 'xys', key: 'countGoldN', values: [3, 5, 8] },
  { group: 'xys', key: 'countDeadN', values: [2, 4, 6] },
  { group: 'kp', key: 'hhvllv', values: [20, 35, 50] },
  { group: 'kp', key: 'sma1N', values: [20, 35, 50] },
  { group: 'kp', key: 'smaFastN', values: [2, 3, 5] },
  { group: 'kp', key: 'smaFast2N', values: [2, 3, 5] },
  { group: 'kp', key: 'b1Offset', values: [20, 35, 50] },
  { group: 'gates', key: 'bullBearHHVLLV', values: [13, 21, 34] },
];
const STAGE_C: PSpec[] = [
  { group: 'sa', key: 'ma20Mult', values: [1.0, 1.05, 1.1, 1.15, 1.2] },
  { group: 'sa', key: 'recentGate', values: [2, 4, 8] },
  { group: 'dualB', key: 'zhinengMult', values: [0.90, 0.93, 0.95, 0.97, 0.99] },
  { group: 'gates', key: 'a3KongPan', values: [60, 70, 80, 90] },
  { group: 'gates', key: 'bullMult', values: [1.05, 1.1, 1.15] },
  { group: 'gates', key: 'bearMult', values: [0.85, 0.9, 0.95] },
  { group: 'gates', key: 'a4Recent', values: [0.0, 0.1, 0.3, 0.6, 1.0] },
  { group: 'gates', key: 'a5CountN', values: [30, 50, 80] },
  { group: 'gates', key: 'a7CountN', values: [15, 30, 50] },
  { group: 'kp', key: 'gate', values: [0, 3, 6] },
  { group: 'catch', key: 'volMa', values: [3, 5, 10] },
  { group: 'catch', key: 'volSurgeMult', values: [1.2, 1.5, 2.0, 3.0] },
];
const STAGE_D: PSpec[] = [
  { group: 'level', key: 'strictSA', values: [0.5, 1.5, 2.8, 4.0, 6.0] },
  { group: 'level', key: 'strictMS', values: [0.5, 2.0, 3.9, 6.0, 8.0] },
  { group: 'level', key: 'mediumEps', values: [0.0, 0.01, 0.1, 0.3, 0.5] },
];
const STAGES: { name: string; specs: PSpec[] }[] = [
  { name: 'A 分數shape', specs: STAGE_A }, { name: 'B 雙B/XYS shape', specs: STAGE_B },
  { name: 'C 門檻(非凍結scale)', specs: STAGE_C }, { name: 'D 選股切點', specs: STAGE_D },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
const getP = (p: SanSeParams, s: PSpec): number => (p as any)[s.group][s.key];
const setP = (p: SanSeParams, s: PSpec, v: number): void => { (p as any)[s.group][s.key] = v; };

// ── 分階段 coordinate descent ───────────────────────────────────
function optimize(stocks: StockData[], cutLow: string, base: Baseline, passes: number, log: (m: string) => void): { params: SanSeParams; evals: number } {
  const P = cloneParams(PRODUCTION_PARAMS);
  let cur = leanScore(stocks, P, cutLow, base);
  let evals = 1;
  log(`  起點 production in-sample lift 分數 ${cur.toFixed(4)}（大盤基準勝率d5 ${(base.winD5 * 100).toFixed(0)}%）`);
  for (let pass = 1; pass <= passes; pass++) {
    let improved = false;
    for (const stage of STAGES) {
      for (const spec of stage.specs) {
        const orig = getP(P, spec);
        let bestVal = orig, bestSc = cur;
        for (const v of spec.values) {
          if (v === orig) continue;
          setP(P, spec, v);
          const sc = leanScore(stocks, P, cutLow, base); evals++;
          if (sc > bestSc + EPS) { bestSc = sc; bestVal = v; }
          if (evals >= MAX_EVALS) break;
        }
        setP(P, spec, bestVal);
        if (bestVal !== orig) { improved = true; cur = bestSc; }
        if (evals >= MAX_EVALS) { log(`  ⚠ 觸 MAX_EVALS=${MAX_EVALS}，提前結束`); return { params: P, evals }; }
      }
      // stage D：strictSA × strictMS 小聯合掃（兩者共決定 top/prime 母體，1D descent 易卡）
      if (stage.name.startsWith('D')) {
        const saVals = STAGE_D[0].values, msVals = STAGE_D[1].values;
        let bSA = P.level.strictSA, bMS = P.level.strictMS, bSc = cur;
        for (const sa of saVals) for (const ms of msVals) {
          P.level.strictSA = sa; P.level.strictMS = ms;
          const sc = leanScore(stocks, P, cutLow, base); evals++;
          if (sc > bSc + EPS) { bSc = sc; bSA = sa; bMS = ms; }
          if (evals >= MAX_EVALS) break;
        }
        P.level.strictSA = bSA; P.level.strictMS = bMS;
        if (bSc > cur + EPS) { improved = true; cur = bSc; }
      }
      log(`  pass${pass} ${stage.name} → 分數 ${cur.toFixed(4)}（evals ${evals}）`);
      if (evals >= MAX_EVALS) return { params: P, evals };
    }
    if (!improved) { log(`  pass${pass} 無改善 → 收斂`); break; }
  }
  return { params: P, evals };
}

// ── 參數 diff（只列有變的葉）──
function paramDiff(a: SanSeParams, b: SanSeParams): { path: string; from: number; to: number }[] {
  const out: { path: string; from: number; to: number }[] = [];
  for (const g of Object.keys(a) as (keyof SanSeParams)[]) {
    const ga = a[g] as Record<string, unknown>, gb = b[g] as Record<string, unknown>;
    for (const k of Object.keys(ga)) {
      if (k === 'thresholds') continue;
      if (ga[k] !== gb[k]) out.push({ path: `${g}.${k}`, from: ga[k] as number, to: gb[k] as number });
    }
  }
  return out;
}

// ── 彩柱研究（§4 預測式門檻；turnover 走「走圖同源」：CN 騰訊 cnDayExtras / TW 本地量+FinMind，
//    確保 X11 尺度與門檻 [6.1,...]/[2.25,...] 一致。X10/X9 量單位自抵消、可用本地量算）──
type Tier = 'green' | 'yellow' | 'cyan' | 'blue' | 'none';
async function tierStudy(market: Market, stocks: StockData[], log: (m: string) => void, outDir: string): Promise<string[]> {
  const L: string[] = [];
  const baseThr: TierThresholds = market === 'TW' ? TW_TIER_THRESHOLDS : CN_TIER_THRESHOLDS;
  const P = PRODUCTION_PARAMS;
  // turnover 快取（CN: 騰訊 date→換手率%；TW: 發行股數常數）
  const cachePath = path.join(outDir, market === 'CN' ? 'tencent-turnover-cache.json' : 'shares-cache.json');
  let cache: Record<string, Record<string, number> | number> = {};
  try { cache = JSON.parse(await fs.readFile(cachePath, 'utf8')); } catch { /* 無快取 */ }
  let fetched = 0, miss = 0;
  // 回傳對齊 sd.candles 的 turnover[]（NaN=當日無資料）；取不到回 null。
  const turnoverOf = async (sd: StockData): Promise<number[] | null> => {
    if (market === 'CN') {
      let map = cache[sd.symbol] as Record<string, number> | undefined;
      if (!map) {
        const m = await fetchDayExtras(sd.symbol);     // 騰訊：date → {turnover(%)}，與走圖彩柱同源
        map = {}; for (const [d, v] of m) if (Number.isFinite(v.turnover)) map[d] = +v.turnover.toFixed(4);
        cache[sd.symbol] = map; fetched++;
      }
      if (!Object.keys(map).length) return null;
      return sd.candles.map((c) => { const v = (map as Record<string, number>)[c.date]; return typeof v === 'number' ? v : NaN; });
    }
    let sh = cache[sd.symbol] as number | undefined;
    if (sh == null) { const v = await getSharesIssued(sd.symbol.replace(/\.(TW|TWO)$/i, '')); sh = (typeof v === 'number' && v > 0) ? v : 0; cache[sd.symbol] = sh; fetched++; }
    if (!(sh > 0)) return null;
    return sd.candles.map((c) => (c.volume * 1000) / (sh as number) * 100); // 台股 周轉% = 成交張×1000 ÷ 發行股 ×100
  };

  const byTier: Record<Tier, number[]> = { green: [], yellow: [], cyan: [], blue: [], none: [] };
  const x11Hits: { x11: number; d5: number }[] = [];   // baseOK 的 (換手率EMA, d5)，供預測式門檻掃
  let usable = 0; const covDates = new Set<string>();
  for (const sd of stocks) {
    const turnover = await turnoverOf(sd);
    if (!turnover) { miss++; continue; }
    const amount = sd.candles.map((c) => c.close * c.volume * 100);  // X9/X10 量單位自抵消 → 本地量即可
    const vol = sd.candles.map((c) => c.volume);
    const C = sd.candles.map((c) => c.close);
    const xys = computeXys(sd.candles);
    const X8 = EMA(amount, P.tier.amountEma), X7 = EMA(vol, P.tier.volEma);
    const X9 = div(div(X8, X7), 100);
    const X10 = mul(div(sub(C, X9), X9), 100);
    const X11 = EMA(turnover, P.tier.turnoverEma);
    let used = false;
    const hi = sd.n - 1 - FWD_WINDOW;
    for (let i = WARMUP; i <= hi; i++) {
      const f = sd.fwd[i]; if (!f || !f.tradable || f.d5 == null) continue;
      if (!(isNum(X10[i]) && isNum(X11[i]) && X10[i] > P.tier.devGate && xys.xys1[i] > 0)) continue;
      x11Hits.push({ x11: X11[i], d5: f.d5 });
      const t = X11[i];
      const tier: Tier = t > baseThr[0] ? 'green' : t > baseThr[1] ? 'yellow' : t > baseThr[2] ? 'cyan' : t > baseThr[3] ? 'blue' : 'none';
      byTier[tier].push(f.d5); used = true; covDates.add(sd.candles[i].date);
    }
    if (used) usable++;
  }
  if (fetched) { await fs.writeFile(cachePath, JSON.stringify(cache), 'utf8'); log(`  彩柱：turnover 來源抓 ${fetched} 檔（快取 ${path.relative(process.cwd(), cachePath)}）`); }
  L.push('## 5. 捕撈季節 4 級量能彩柱研究（§4，僅走圖視覺、不參與選股）');
  L.push('');
  if (usable < 20 || x11Hits.length < 50) {
    L.push(`⚠️ 可用樣本不足（usable ${usable} 檔 / baseOK ${x11Hits.length} 筆 / 取不到 ${miss} 檔）→ 跳過（${market === 'CN' ? '騰訊' : 'FinMind'} 限流或無資料）。`);
    L.push('');
    return L;
  }
  const dates = [...covDates].sort();
  const meanWin = (a: number[]) => (a.length ? { n: a.length, avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), win: +((a.filter((x) => x > 0).length / a.length) * 100).toFixed(0) } : { n: 0, avg: null as number | null, win: null as number | null });
  L.push(`turnover 來源：${market === 'CN' ? '騰訊 cnDayExtras 換手率%（與走圖彩柱同源；歷史約近 500 交易日）' : '本地量 + FinMind 發行股 twDayExtras'}｜涵蓋 ${usable} 檔 / ${dates[0]}~${dates[dates.length - 1]}｜baseOK(X10>${P.tier.devGate} 且動能>0) ${x11Hits.length} 筆（描述性、全可用窗、chart-only）。各 tier forward d5：`);
  L.push('');
  L.push('| tier | 樣本 | 平均d5 | 勝率 |');
  L.push('|---|--:|--:|--:|');
  for (const t of ['green', 'yellow', 'cyan', 'blue', 'none'] as Tier[]) {
    const s = meanWin(byTier[t]); L.push(`| ${t} | ${s.n} | ${fp(s.avg)} | ${fw(s.win)} |`);
  }
  L.push('');
  // 預測式綠柱門檻：掃 X11 候選切點，最大化「X11>cut 的 d5 勝率」且 n≥floor
  const sortedX11 = [...x11Hits].sort((a, b) => a.x11 - b.x11);
  const floor = Math.max(30, Math.floor(x11Hits.length * 0.05));
  let bestCut: number | null = null, bestWin = -1, bestN = 0;
  for (let q = 0.5; q <= 0.97; q += 0.02) {
    const cut = sortedX11[Math.floor(sortedX11.length * q)].x11;
    const sub = x11Hits.filter((h) => h.x11 > cut);
    if (sub.length < floor) continue;
    const win = sub.filter((h) => h.d5 > 0).length / sub.length;
    if (win > bestWin) { bestWin = win; bestCut = +cut.toFixed(2); bestN = sub.length; }
  }
  const greenS = meanWin(byTier.green), noneS = meanWin(byTier.none);
  const predictive = greenS.win != null && noneS.win != null && greenS.win - noneS.win >= 3;
  L.push(`綠柱 vs none 勝率差 ${greenS.win != null && noneS.win != null ? `${greenS.win - noneS.win > 0 ? '+' : ''}${greenS.win - noneS.win}pp` : '—'} → ${predictive ? '頂層彩柱**有**預測傾向' : '頂層彩柱與 none 無明顯差 → 偏**純視覺**'}。`);
  if (bestCut != null) {
    const newThr = [bestCut, +(bestCut * 0.62).toFixed(2), +(bestCut * 0.34).toFixed(2), +(bestCut * 0.30).toFixed(2)];
    L.push(`**預測式綠柱門檻**：X11 切點 ${bestCut}（d5 勝率 ${(bestWin * 100).toFixed(0)}%, n=${bestN}）→ 建議 ${market} 門檻 ≈ [${newThr.join(', ')}]（下三級按原比例下推）；對照現行 [${baseThr.join(', ')}]。`);
  } else {
    L.push('預測式門檻：無切點滿足 min-sample → 維持純視覺。');
  }
  L.push('');
  return L;
}

// ── 報告 ────────────────────────────────────────────────────────
function tableRows(label: string, picks: PickRec[]): string {
  const s = summarize(picks);
  return `| ${label} | ${s.n} | ${fw(s.winD3)} | ${fw(s.winD5)} | ${fp(s.avgD3)} | ${fp(s.avgD5)} | ${fp(s.avgD10)} | ${fp(s.avgMg)} |`;
}

async function main() {
  const market = (process.argv[2] ?? '').toUpperCase() as Market;
  if (market !== 'TW' && market !== 'CN') throw new Error('用法：optimize-sanse-params.ts <TW|CN> [sampleN] [passes]');
  const sampleN = parseInt(process.argv[3] ?? '', 10) || DEFAULT_SAMPLE[market];
  const passes = parseInt(process.argv[4] ?? '', 10) || DEFAULT_PASSES;
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = getLocalCandleDir(market);
  const outDir = path.join(process.cwd(), 'data', market === 'TW' ? 'tw-sanse' : 'cn-sanse');
  await fs.mkdir(outDir, { recursive: true });
  const log = (m: string) => console.log(m);

  // 指數（行情日曆 + RS 基準 + regime）
  const idxSH = await readRaw(dir, market === 'TW' ? TW_INDEX : CN_INDEX_SH);
  if (!idxSH || !idxSH.length) throw new Error(`找不到指數 K 線`);
  const idxMapSH = dateToClose(idxSH);
  const idxMapSZ = market === 'CN' ? dateToClose(await readRaw(dir, CN_INDEX_SZ)) : idxMapSH;
  const idxMapSZeff = idxMapSZ.size > 0 ? idxMapSZ : idxMapSH;
  const regime = buildRegime(idxSH);
  const idxDates = idxSH.map((c) => c.date);

  // train/OOS 切分 + embargo（以指數交易日為軸）
  const cutIdx = Math.floor(idxDates.length * TRAIN_FRAC);
  const cutLow = idxDates[cutIdx];
  const cutHigh = idxDates[Math.min(idxDates.length - 1, cutIdx + FWD_WINDOW)];
  log(`[opt] ${market}｜train < ${cutLow}｜embargo ${FWD_WINDOW} 根｜OOS ≥ ${cutHigh}`);

  // universe → 抽樣 → 預算 forward（零 API）
  const universe = seededSample(await loadUniverse(market, dir), sampleN, SEED);
  log(`[opt] ${market} 抽樣 ${universe.length} 檔（種子 ${SEED}）；載入 + forward 預算中…`);
  const stocks: StockData[] = [];
  const BATCH = 80;
  for (let b = 0; b < universe.length; b += BATCH) {
    const batch = universe.slice(b, b + BATCH);
    const loaded = await Promise.all(batch.map((s) => readRaw(dir, s)));
    batch.forEach((symbol, k) => {
      const candles = loaded[k];
      if (!candles || candles.length < MIN_BARS) return;
      const O = candles.map((c) => c.open), H = candles.map((c) => c.high), L = candles.map((c) => c.low), C = candles.map((c) => c.close);
      const n = candles.length;
      const homeIdx = market === 'CN' && symbol.endsWith('.SZ') ? idxMapSZeff : idxMapSH;
      let last = NaN;
      const indexClose = candles.map((c) => { const v = homeIdx.get(c.date); if (v != null) last = v; return last; });
      const fwd: (Fwd | null)[] = new Array(n).fill(null);
      for (let i = WARMUP; i <= n - 1 - FWD_WINDOW; i++) fwd[i] = forwardAt(O, H, L, C, n, i);
      stocks.push({ symbol, candles, indexClose, fwd, n });
    });
  }
  log(`[opt] ${market} 可用 ${stocks.length} 檔（歷史 ≥ ${MIN_BARS} 根）`);
  if (stocks.length < 20) throw new Error(`可用股票太少（${stocks.length}）`);

  // ── 搜尋 ──
  const base = marketBaseline(stocks, (d) => d < cutLow);
  log(`[opt] ${market} 大盤基準（train 全可進場 K 棒）：勝率d5 ${(base.winD5 * 100).toFixed(1)}%（n=${base.n}）`);
  log(`[opt] ${market} 分階段 coordinate descent（passes ${passes}）…`);
  const t0 = Date.now();
  const { params: best, evals } = optimize(stocks, cutLow, base, passes, log);
  log(`[opt] ${market} 搜尋完成：${evals} evals / ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── 全宇宙驗證？此處沿用抽樣集做最終 IS/OOS 詳細統計（plan：贏家可另在全宇宙驗，先報抽樣）──
  const prodPicks = collectPicks(stocks, PRODUCTION_PARAMS, cutLow, cutHigh, regime);
  const bestPicks = collectPicks(stocks, best, cutLow, cutHigh, regime);
  const pool = (ps: PickRec[]) => ps.filter((p) => p.pool);                      // 優化目標：操作池(mainforce)
  const buy = (ps: PickRec[]) => ps.filter((p) => p.grade === 'top' || p.grade === 'prime'); // 參考：該買集
  const oos = (ps: PickRec[]) => ps.filter((p) => p.seg === 'out');
  const ins = (ps: PickRec[]) => ps.filter((p) => p.seg === 'in');

  const prodPoolOOS = summarize(pool(oos(prodPicks)));
  const bestPoolOOS = summarize(pool(oos(bestPicks)));
  const bestPoolIS = summarize(pool(ins(bestPicks)));
  const gapWinD5 = (bestPoolIS.winD5 != null && bestPoolOOS.winD5 != null) ? bestPoolIS.winD5 - bestPoolOOS.winD5 : null;
  const edgeWinD5 = (bestPoolOOS.winD5 != null && prodPoolOOS.winD5 != null) ? bestPoolOOS.winD5 - prodPoolOOS.winD5 : null;
  const edgeAvgD5 = (bestPoolOOS.avgD5 != null && prodPoolOOS.avgD5 != null) ? +(bestPoolOOS.avgD5 - prodPoolOOS.avgD5).toFixed(2) : null;

  // ── 報告 ──
  const mk = market === 'TW' ? '台股' : '陸股';
  const L: string[] = [];
  L.push(`# 三色 參數最佳化 — ${mk}（${stamp}）  ⚠️ 研究用、未接 production`);
  L.push('');
  L.push('## 0. 方法與警語');
  L.push(`- 抽樣 ${stocks.length} 檔（種子 ${SEED}）｜train < ${cutLow}｜embargo ${FWD_WINDOW} 根｜OOS ≥ ${cutHigh}`);
  L.push(`- 目標函數：**操作池**（mainforce.buyHit＝使用者實際選股清單）in-sample d5 **勝率 lift（池勝率 − 大盤基準勝率）**＋小幅 avg/d3；硬閘只擋 min-sample ${MIN_SAMPLES}。用 lift 防「把池放大到逼近大盤」灌水。`);
  L.push(`- 搜尋 ${evals} evals；scale 乘數（slopeMult/ms.mult/kp.mult）凍結（與門檻冗餘）。`);
  L.push('- 註：池成員由 主力分數 + A11(XYS) + 牛熊/控盤閘 + 嚴/中/寬切點 決定；雙B/捕撈金叉是 combo grade 的「觸發/排序」、不決定池成員 → 其參數對此目標無槓桿、會留在 production（見 §2 grade 看其排序價值）。');
  L.push(`- ⚠️ 全參數搜尋 + 金融資料 → 唯 **OOS 差距** 可信；in-sample 勝出多半是過擬合。`);
  L.push('');
  L.push('## 1. 頭條 — production vs 最佳化（操作池＝優化目標）');
  L.push('');
  L.push('| variant | 窗 | n | 勝率d3 | 勝率d5 | 平均d3 | 平均d5 | 平均d10 | 平均最高 |');
  L.push('|---|---|--:|--:|--:|--:|--:|--:|--:|');
  L.push(tableRows('production@OOS', pool(oos(prodPicks))));
  L.push(tableRows('optimized@IS', pool(ins(bestPicks))));
  L.push(tableRows('optimized@OOS', pool(oos(bestPicks))));
  const baseOOS = marketBaseline(stocks, (d) => d >= cutHigh);
  L.push(`| _大盤基準@OOS_ | OOS | ${baseOOS.n} | ${(baseOOS.winD3 * 100).toFixed(0)}% | ${(baseOOS.winD5 * 100).toFixed(0)}% | — | — | — | — |`);
  L.push('');
  L.push(`> 池要「贏」必須勝率明顯高於 _大盤基準@OOS_（${(baseOOS.winD5 * 100).toFixed(0)}%）；只是把池放大到逼近基準不算 alpha。`);
  L.push('');
  L.push('### 1b. 參考：該買集（combo grade ∈ {top, prime}）OOS');
  L.push('');
  L.push('| variant | 窗 | n | 勝率d3 | 勝率d5 | 平均d3 | 平均d5 | 平均d10 | 平均最高 |');
  L.push('|---|---|--:|--:|--:|--:|--:|--:|--:|');
  L.push(tableRows('production@OOS', buy(oos(prodPicks))));
  L.push(tableRows('optimized@OOS', buy(oos(bestPicks))));
  L.push('');
  L.push(`- **過擬合差距**（optimized IS−OOS 勝率d5）：${gapWinD5 == null ? '—' : `${gapWinD5 > 0 ? '+' : ''}${gapWinD5}pp`}`);
  L.push(`- **對 production 的 OOS 淨勝**（勝率d5）：${edgeWinD5 == null ? '—' : `${edgeWinD5 > 0 ? '+' : ''}${edgeWinD5}pp`}｜平均d5 淨勝 ${edgeAvgD5 == null ? '—' : fp(edgeAvgD5)}`);
  L.push('');
  L.push('## 2. 逐 combo grade（OOS）');
  L.push('');
  L.push('| grade | variant | n | 勝率d3 | 勝率d5 | 平均d3 | 平均d5 | 平均d10 | 平均最高 |');
  L.push('|---|---|--:|--:|--:|--:|--:|--:|--:|');
  for (const g of ['top', 'prime', 'mid', 'watch', 'weak'] as Grade[]) {
    L.push(tableRows(`${g}·production`, oos(prodPicks).filter((p) => p.grade === g)));
    L.push(tableRows(`${g}·optimized`, oos(bestPicks).filter((p) => p.grade === g)));
  }
  L.push('');
  L.push('## 3. 逐 regime（OOS，操作池）— 邊際有沒有撐過各盤勢');
  L.push('');
  L.push('| regime | variant | n | 勝率d5 | 平均d5 |');
  L.push('|---|---|--:|--:|--:|');
  for (const r of ['bull', 'chop', 'bear'] as Regime[]) {
    const pp = summarize(pool(oos(prodPicks)).filter((p) => p.regime === r));
    const bb = summarize(pool(oos(bestPicks)).filter((p) => p.regime === r));
    L.push(`| ${r} | production | ${pp.n} | ${fw(pp.winD5)} | ${fp(pp.avgD5)} |`);
    L.push(`| ${r} | optimized | ${bb.n} | ${fw(bb.winD5)} | ${fp(bb.avgD5)} |`);
  }
  L.push('');
  L.push('## 4. 最佳化參數 diff（vs production，只列有變）');
  L.push('');
  const diff = paramDiff(PRODUCTION_PARAMS, best);
  if (!diff.length) { L.push('（無變化 — 搜尋未找到優於 production 的參數）'); }
  else { L.push('| 參數 | production | optimized |'); L.push('|---|--:|--:|'); for (const d of diff) L.push(`| ${d.path} | ${d.from} | ${d.to} |`); }
  L.push('');

  // ── 彩柱研究（network，可能跳過）──
  if (process.env.OPT_SKIP_TIERS) { L.push('## 5. 捕撈彩柱研究'); L.push('（OPT_SKIP_TIERS=1 → 略過）'); L.push(''); }
  else {
    try { L.push(...await tierStudy(market, stocks, log, outDir)); }
    catch (e) { L.push('## 5. 捕撈彩柱研究'); L.push(`（失敗：${e instanceof Error ? e.message : e}）`); L.push(''); }
  }

  // ── 建議 ──
  L.push('## 6. 建議');
  const noise = 3;
  const liftOOS = (bestPoolOOS.winD5 != null) ? +(bestPoolOOS.winD5 - baseOOS.winD5 * 100).toFixed(0) : null; // 優化池@OOS 對大盤的勝率 lift
  const beatsMarket = liftOOS != null && liftOOS > noise;
  const beatsProd = edgeWinD5 != null && edgeWinD5 > noise;
  const avgOK = edgeAvgD5 == null || edgeAvgD5 >= 0;
  const promote = beatsMarket && beatsProd && avgOK;
  L.push('');
  L.push(`promote 規則：① OOS 對 production 淨勝 > 噪音帶(~${noise}pp) ② OOS 對**大盤基準**勝率 lift > ${noise}pp（真 alpha、非放大到基準）③ avg 不更差 ④ ≥2/3 regime 守得住。`);
  L.push(`本次：對 production 淨勝 ${edgeWinD5 == null ? '—' : `${edgeWinD5}pp`}｜對大盤 lift ${liftOOS == null ? '—' : `${liftOOS > 0 ? '+' : ''}${liftOOS}pp`}｜過擬合差距 ${gapWinD5 == null ? '—' : `${gapWinD5}pp`} → **${promote ? '可考慮 PROMOTE（仍須人看逐 regime + 全宇宙複驗）' : `DO-NOT-PROMOTE（${!beatsMarket ? '未明顯贏大盤基準' : !beatsProd ? 'OOS 未明顯贏 production' : 'avg 更差'}）`}**`);
  L.push('');
  L.push('> 要 promote：把 optimize-result JSON 的參數手填進 lib/cn-sanse/params.ts 的 EXPERIMENTAL_PARAMS_*（另一個 PR），本腳本不自動接線。');

  const reportPath = path.join(outDir, `optimize-report-${market}-${stamp}.md`);
  await fs.writeFile(reportPath, L.join('\n'), 'utf8');
  await fs.writeFile(path.join(outDir, `optimize-result-${market}.json`), JSON.stringify({
    market, stamp, sample: stocks.length, evals, cutLow, cutHigh,
    headline: { prodPoolOOS, bestPoolOOS, bestPoolIS, gapWinD5, edgeWinD5, edgeAvgD5 },
    diff, params: best,
  }, null, 2), 'utf8');
  log(`[opt] ${market} 報告 → ${path.relative(process.cwd(), reportPath)}`);
  console.log('\n' + L.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
