// ============================================================
// 三色 × 雙B × 捕撈 —— 「使用順序」實證回測（研究腳本，TW / CN 通用）
//
// 目的：系統現在把三組指標當「平行 OR」（任一組買點成立就入選），從沒定義過
//   「先用主力狀態看紫/紅，再用雙B或捕撈抓進出場」這種順序到底有沒有 alpha。
//   這支腳本回推歷史，把三指標的逐日訊號攤平成布林，比較多種進場順序模型 + 出場規則的
//   未來報酬，推導出可用的 playbook。
//
// 方法（為什麼這樣寫）：
//   - 每檔股票載入完整 K 線「一次」，用 computeSanSe（三色逐日分數）+ tdx 原語自算
//     雙B/捕撈逐日 cross → O(N) 拿到整段對齊每根 K 的布林。不逐日 truncate 重算（避免 O(N²)）。
//   - forward 報酬純本地算（隔日開進場、close[i+k] 計 dK，語義對齊 lib/cn-sanse/forwardMetrics.ts），
//     不打 FinMind / analyzeForwardBatch（避開限流、快 1-2 個數量級）。
//   - 漲停買不到的隔日開（鎖死 / 追停跳空 ≥9.5%）→ 剔除，避免倖存者偏差。
//
// ⚠️ 三色是自創因子（鐵則 #5/#10：台股選股正式路徑只用書本規則）。此腳本只供「探索三指標
//    搭配順序」，不改 production 掃描，不接選股鏈路。是否 promote 由使用者看完報告決定。
//
// 用法：npx tsx scripts/research-sanse-combo.ts [market=TW|CN] [days=480] [lookbackK=5]
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { REF, MA, EMA, HHV, CROSS, add, sub, mul, div, isNum } from '@/lib/cn-sanse/tdx';
import type { Candle } from '@/types';

type Market = 'TW' | 'CN';

const FWD_WINDOW = 32;        // forward 量測窗（交易日）：maxGain/maxLoss 掃此窗，並確保 d20 有空間
const MAX_HOLD = 32;          // 出場最長持有（找不到賣訊就窗末出）
const ENTRY_MIN_IDX = 480;    // 黃(midControl) 吃 SUM(vol,480)，需 ~480 根才有效 → 所有模型同一起點才公平
const MIN_BARS = ENTRY_MIN_IDX + FWD_WINDOW + 8; // ~520：個股至少要這麼長才進場
const LIMIT_GAP = 0.095;      // 隔日開相對訊號日收 ≥9.5% 視為追停買不到（TW/CN 主板都 10% 限幅）

// ZB4 線性加權：lag0=20,1=19,...,18=2, lag19=0(原碼跳過), lag20=1，總和 210（同 indicators.ts）
const ZB4_W = (() => { const w = new Array(21).fill(0); for (let l = 0; l <= 18; l++) w[l] = 20 - l; w[20] = 1; return w; })();

// ── 逐日訊號（全部與 candle index 對齊） ─────────────────────────
interface Sig {
  n: number;
  dates: string[];
  O: number[]; H: number[]; L: number[]; C: number[];
  // 三色（主力狀態F）
  purple: boolean[]; red: boolean[]; yellow: boolean[];
  ignite: boolean[]; develop: boolean[]; full: boolean[]; mainBuy: boolean[];
  // 雙B戰法
  bGold: boolean[]; bDead: boolean[]; bBreak: boolean[]; bBreakDn: boolean[]; aboveMa60: boolean[];
  // 捕撈季節
  cGold: boolean[]; cDead: boolean[]; xAbove0: boolean[]; xBelow0: boolean[]; volSurge: boolean[];
  // 出場輔助
  ma5Dn: boolean[]; ma10Dn: boolean[]; redTurnNeg: boolean[];
}

function computeSignals(candles: Candle[], indexClose: number[]): Sig {
  const n = candles.length;
  const O = candles.map((c) => c.open);
  const H = candles.map((c) => c.high);
  const L = candles.map((c) => c.low);
  const C = candles.map((c) => c.close);
  const V = candles.map((c) => c.volume);
  const dates = candles.map((c) => c.date);

  // 三色：直接用選股引擎的逐日分數（紫=shortAttack>0、紅=midStrength>0、黃=midControl>0）
  const s = computeSanSe(candles, indexClose);
  const purple = s.shortAttack.map((x) => isNum(x) && x > 0);
  const red = s.midStrength.map((x) => isNum(x) && x > 0);
  const yellow = s.midControl.map((x) => isNum(x) && x > 0);
  const ignite = s.loose;     // 紫剛翻正（點火）
  const develop = s.medium;   // 三分數都>0.01（發展）
  const full = s.strict;      // 三色共振（滿分）
  const mainBuy = ignite.map((g, i) => g || develop[i] || full[i]); // = mainforce.buyHit 逐日版

  // 雙B戰法（重現 indicators.ts:117–132）
  const ZB = candles.map((c) => (c.close + c.high + c.open + c.low) / 4);
  const zhineng = mul(HHV(ZB, 13), 0.95);
  const ZB3 = candles.map((c) => (3 * c.close + c.open + c.low + c.high) / 6);
  const zb4 = new Array(n).fill(NaN);
  for (let i = 20; i < n; i++) { let q = 0; for (let l = 0; l <= 20; l++) q += ZB4_W[l] * ZB3[i - l]; zb4[i] = q / 210; }
  const zb5 = MA(zb4, 6);
  const bGold = CROSS(zb4, zb5);
  const bDead = CROSS(zb5, zb4);
  const bBreak = CROSS(C, zhineng);
  const bBreakDn = CROSS(zhineng, C);
  const ma60 = MA(C, 60);
  const aboveMa60 = C.map((c, i) => isNum(ma60[i]) && c > ma60[i]);

  // 捕撈季節（重現 indicators.ts:160–173）
  const X1 = div(add(add(mul(C, 2), H), L), 3);
  const X4 = EMA(EMA(EMA(X1, 3), 3), 3);
  const XYS0 = mul(div(sub(X4, REF(X4, 1)), REF(X4, 1)), 100);
  const XYS1 = XYS0;
  const XYS2 = MA(XYS0, 2);
  const cGold = CROSS(XYS1, XYS2);
  const cDead = CROSS(XYS2, XYS1);
  const xAbove0 = XYS1.map((x) => isNum(x) && x > 0);
  const xBelow0 = XYS1.map((x) => isNum(x) && x < 0);
  const vMa5 = MA(V, 5);
  const volSurge = V.map((v, i) => isNum(vMa5[i]) && vMa5[i] > 0 && v > vMa5[i] * 1.5);

  // 出場輔助：MA5/MA10 跌破（書本短/中線停利）、紅翻負（中線主力轉弱）
  const ma5 = MA(C, 5);
  const ma10 = MA(C, 10);
  const ma5Dn = C.map((c, i) => i > 0 && isNum(ma5[i - 1]) && C[i - 1] >= ma5[i - 1] && isNum(ma5[i]) && c < ma5[i]);
  const ma10Dn = C.map((c, i) => i > 0 && isNum(ma10[i - 1]) && C[i - 1] >= ma10[i - 1] && isNum(ma10[i]) && c < ma10[i]);
  const ms = s.midStrength;
  const redTurnNeg = ms.map((x, i) => i > 0 && isNum(ms[i - 1]) && ms[i - 1] >= 0 && isNum(x) && x < 0);

  return {
    n, dates, O, H, L, C,
    purple, red, yellow, ignite, develop, full, mainBuy,
    bGold, bDead, bBreak, bBreakDn, aboveMa60,
    cGold, cDead, xAbove0, xBelow0, volSurge,
    ma5Dn, ma10Dn, redTurnNeg,
  };
}

// ── 進場模型：回傳 bar i 命中哪些模型 id ────────────────────────
function anyBack(a: boolean[], lo: number, hi: number): boolean {
  for (let j = Math.max(0, lo); j <= hi; j++) if (a[j]) return true;
  return false;
}

const CORE_MODELS = new Set(['M1', 'M1_bull', 'M1_bear', 'M2', 'M3', 'M3b', 'M4', 'M5']); // 寫進 jsonl 的核心模型

function entryHits(g: Sig, i: number, K: number): string[] {
  const trig = g.bGold[i] || g.bBreak[i] || g.cGold[i];      // 「觸發」= 雙B金叉/突破 或 捕撈金叉
  const m5 = g.mainBuy[i] && (g.bGold[i] || g.bBreak[i]) && g.cGold[i];
  const hits: string[] = [];

  // 單指標基準（驗證「組合/順序」是否真的勝過單用一個）
  if (g.purple[i]) hits.push('purple_only');
  if (g.red[i]) hits.push('red_only');
  if (g.bGold[i] || g.bBreak[i]) hits.push('B_only');
  if (g.cGold[i]) hits.push('C_only');
  if (g.mainBuy[i]) hits.push('Main_only');

  // M0 現行 flat-OR
  if (g.bGold[i] || g.bBreak[i] || g.cGold[i] || g.mainBuy[i]) hits.push('M0');

  // M1 家族：主力(紅)為前提 + 捕撈金叉觸發
  if (g.red[i] && g.cGold[i]) hits.push('M1');
  if ((g.red[i] || g.purple[i] || g.yellow[i]) && g.cGold[i]) hits.push('M1_any');
  if (g.red[i] && g.cGold[i] && g.xAbove0[i]) hits.push('M1_bull');   // 多頭區金叉（趨勢延續）
  if (g.red[i] && g.cGold[i] && g.xBelow0[i]) hits.push('M1_bear');   // 空頭區金叉（底部反彈）
  if (g.red[i] && g.cGold[i] && g.aboveMa60[i]) hits.push('M1_ma60'); // 加 60 日多空線過濾

  // M2 家族：主力(紅)為前提 + 雙B 觸發
  if (g.red[i] && (g.bGold[i] || g.bBreak[i])) hits.push('M2');
  if (g.red[i] && g.bGold[i]) hits.push('M2_gold');

  // M3 家族：你的假設「紫色出來→再用雙B/捕撈看進場」
  if (g.purple[i] && trig) hits.push('M3b');                       // 紫亮著 + 當日觸發
  if (anyBack(g.ignite, i - K + 1, i) && trig) hits.push('M3');    // 紫啟動 K 根內 + 觸發
  if (anyBack(g.ignite, i - K, i - 1) && trig) hits.push('M3_strict'); // 啟動嚴格早於觸發

  // M4 家族：中線（紅+黃）
  if (g.red[i] && g.yellow[i]) hits.push('M4_pure');               // 紅+黃同亮（不需觸發）
  if (g.red[i] && g.yellow[i] && trig) hits.push('M4');            // 紅+黃 + 觸發

  // M5 家族：三組全共振（最強）
  if (m5) hits.push('M5');
  if (m5 && g.volSurge[i]) hits.push('M5_vol');
  if (m5 && g.aboveMa60[i]) hits.push('M5_ma60');

  // YOURS：使用者描述的「滿配」組合（三色全亮 + 雙B金叉&突破同日 + 捕撈空頭區金叉），逐步放寬看樣本與軌跡
  const threeColors = g.red[i] && g.purple[i] && g.yellow[i];   // 紅+紫+黃 三色全亮
  const dualB = g.bGold[i] && g.bBreak[i];                       // 雙箭頭共振（金叉+突破同日）
  if (threeColors && dualB && g.cGold[i] && g.xBelow0[i]) hits.push('YOURS_exact');         // 完全照你寫的
  if (threeColors && dualB && g.cGold[i]) hits.push('YOURS_noZone');                        // 放寬：捕撈金叉不限0軸
  if (threeColors && (g.bGold[i] || g.bBreak[i]) && g.cGold[i] && g.xBelow0[i]) hits.push('YOURS_anyB'); // 放寬：雙B擇一+空頭區
  if (threeColors && (g.bGold[i] || g.bBreak[i]) && g.cGold[i]) hits.push('YOURS_loose');   // 放寬：三色全亮+任一觸發

  return hits;
}

// ── forward 報酬（隔日開進場；漲停買不到 → tradable=false） ──────
interface Fwd { tradable: boolean; d3: number | null; d5: number | null; d10: number | null; d20: number | null; mg: number; ml: number; }
function forwardMetrics(g: Sig, i: number): Fwd | null {
  if (i + 1 >= g.n) return null;
  const base = g.O[i + 1];
  if (!(base > 0)) return null;
  const eH = g.H[i + 1], eL = g.L[i + 1], eO = g.O[i + 1];
  const locked = eL > 0 && eO === eH && (eH - eL) / eL < 0.005;          // 隔日一字鎖死
  const gapUp = (g.O[i + 1] - g.C[i]) / g.C[i];                          // 追停跳空
  const tradable = !(locked || gapUp >= LIMIT_GAP);
  const closeRet = (k: number): number | null => {
    const idx = i + 1 + k;
    return idx < g.n ? +(((g.C[idx] - base) / base) * 100).toFixed(3) : null;
  };
  let mg = 0, ml = 0;
  for (let k = 0; k < FWD_WINDOW && i + 1 + k < g.n; k++) {
    const hi = ((g.H[i + 1 + k] - base) / base) * 100;
    const lo = ((g.L[i + 1 + k] - base) / base) * 100;
    if (hi > mg) mg = hi;
    if (lo < ml) ml = lo;
  }
  return { tradable, d3: closeRet(2), d5: closeRet(4), d10: closeRet(9), d20: closeRet(19), mg: +mg.toFixed(3), ml: +ml.toFixed(3) };
}

// ── 出場：沿同檔逐日訊號往後找第一個賣訊；進場 open[i+1]、出場 close[j] ──
const EXIT_RULES = ['cDead', 'bDead', 'bBreakDn', 'mainWeak', 'ma5', 'ma10', 'fixed5', 'fixed10'] as const;
type ExitRule = typeof EXIT_RULES[number];
function exitFor(g: Sig, i: number, rule: ExitRule): { ret: number; hold: number } {
  const base = g.O[i + 1];
  const end = Math.min(g.n - 1, i + 1 + MAX_HOLD);
  for (let j = i + 1; j <= end; j++) {
    let fire = false;
    switch (rule) {
      case 'cDead': fire = g.cDead[j]; break;
      case 'bDead': fire = g.bDead[j]; break;
      case 'bBreakDn': fire = g.bBreakDn[j]; break;
      case 'mainWeak': fire = g.redTurnNeg[j]; break;
      case 'ma5': fire = g.ma5Dn[j]; break;
      case 'ma10': fire = g.ma10Dn[j]; break;
      case 'fixed5': fire = j === i + 5; break;
      case 'fixed10': fire = j === i + 10; break;
    }
    if (fire) return { ret: ((g.C[j] - base) / base) * 100, hold: j - (i + 1) };
  }
  return { ret: ((g.C[end] - base) / base) * 100, hold: end - (i + 1) };
}

// ── 統計 ────────────────────────────────────────────────────────
function stat(xs: number[]) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0, mean: null as number | null, median: null as number | null, win: null as number | null };
  const sorted = [...v].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const win = (v.filter((x) => x > 0).length / v.length) * 100;
  return { n: v.length, mean, median, win };
}
const fmtPct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const fmt1 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));

// ── universe ────────────────────────────────────────────────────
async function readRaw(dir: string, symbol: string): Promise<Candle[] | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${symbol}.json`), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.candles)) return null;
    const cs = data.candles as Candle[];
    for (const c of cs) if (typeof c.date === 'string' && c.date.endsWith('*')) c.date = c.date.slice(0, -1); // 去除權息標記
    return cs;
  } catch { return null; }
}

const CN_INDEX_SH = '000001.SS';
const CN_INDEX_SZ = '399001.SZ';
const TW_INDEX = '^TWII';

function isCommonTw(file: string): boolean {
  const m = file.match(/^(\d{4})\.(TW|TWO)\.json$/);
  if (!m) return false;
  if (m[1].startsWith('00')) return false; // ETF
  return true;
}
function isExcludedCn(symbol: string, name: string): boolean {
  const code = symbol.split('.')[0];
  if (/^(30|688|8|4)/.test(code)) return true;                              // 創業板/科創/北交
  if (name.includes('ST') || name.startsWith('*') || name.startsWith('S')) return true; // ST/*ST
  if (name.includes('退')) return true;
  return false;
}

async function loadUniverse(market: Market, dir: string): Promise<string[]> {
  if (market === 'TW') {
    const files = await fs.readdir(dir);
    return files.filter(isCommonTw).map((f) => f.replace(/\.json$/, ''));
  }
  const raw = await fs.readFile(path.join(process.cwd(), 'data/cn_stocklist.json'), 'utf8');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of (JSON.parse(raw).stocks ?? []) as { symbol: string; name: string }[]) {
    if (!s.symbol || s.symbol === CN_INDEX_SH || s.symbol === CN_INDEX_SZ) continue;
    if (isExcludedCn(s.symbol, s.name)) continue;
    if (seen.has(s.symbol)) continue;
    seen.add(s.symbol);
    out.push(s.symbol);
  }
  return out;
}

function dateToCloseMap(cs: Candle[] | null): Map<string, number> {
  const m = new Map<string, number>();
  if (cs) for (const c of cs) m.set(c.date, c.close);
  return m;
}

// ── 主流程 ──────────────────────────────────────────────────────
const MODEL_ORDER = [
  'ALL',
  'purple_only', 'red_only', 'B_only', 'C_only', 'Main_only',
  'M0',
  'M1', 'M1_any', 'M1_bull', 'M1_bear', 'M1_ma60',
  'M2', 'M2_gold',
  'M3', 'M3b', 'M3_strict',
  'M4_pure', 'M4',
  'M5', 'M5_vol', 'M5_ma60',
  'YOURS_exact', 'YOURS_noZone', 'YOURS_anyB', 'YOURS_loose',
];
const LABELS: Record<string, string> = {
  ALL: '全體可進場K棒（基準）',
  purple_only: '只紫亮（短線游資）', red_only: '只紅亮（中線機構）',
  B_only: '只雙B金叉/突破', C_only: '只捕撈金叉', Main_only: '只主力進場(任一階段)',
  M0: 'M0 現行 flat-OR（任一組買點）',
  M1: 'M1 紅濾＋捕撈金叉', M1_any: 'M1any 任一色＋捕撈金叉',
  M1_bull: 'M1多 紅＋捕撈金叉×0軸上', M1_bear: 'M1空 紅＋捕撈金叉×0軸下', M1_ma60: 'M1線 紅＋捕撈金叉×站60日線',
  M2: 'M2 紅濾＋雙B(金叉/突破)', M2_gold: 'M2金 紅＋雙B金叉',
  M3: 'M3 紫啟動K根內＋觸發【你的假設】', M3b: 'M3b 紫亮著＋當日觸發', M3_strict: 'M3嚴 啟動早於觸發＋觸發',
  M4_pure: 'M4純 紅＋黃同亮', M4: 'M4 紅＋黃＋觸發（中線）',
  M5: 'M5 三組全共振', M5_vol: 'M5量 全共振＋爆量', M5_ma60: 'M5線 全共振＋站60日線',
  YOURS_exact: '【你的滿配】三色全亮＋雙箭頭共振＋捕撈空頭區金叉', YOURS_noZone: '【你·放寬1】三色全亮＋雙箭頭共振＋捕撈金叉(不限0軸)',
  YOURS_anyB: '【你·放寬2】三色全亮＋雙B擇一＋捕撈空頭區金叉', YOURS_loose: '【你·放寬3】三色全亮＋雙B擇一＋捕撈金叉',
};

interface Acc { d3: number[]; d5: number[]; d10: number[]; d20: number[]; mg: number[]; ml: number[]; }
const mkAcc = (): Acc => ({ d3: [], d5: [], d10: [], d20: [], mg: [], ml: [] });

async function main() {
  const market = (process.argv[2] ?? 'TW').toUpperCase() as Market;
  if (market !== 'TW' && market !== 'CN') throw new Error('market 只能 TW 或 CN');
  const days = parseInt(process.argv[3] ?? '480', 10) || 480;
  const K = parseInt(process.argv[4] ?? '5', 10) || 5;
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = getLocalCandleDir(market);
  const outDir = path.join(process.cwd(), 'data', market === 'TW' ? 'tw-sanse' : 'cn-sanse');
  await fs.mkdir(outDir, { recursive: true });

  // 指數 date→close
  const idxMapSH = dateToCloseMap(await readRaw(dir, market === 'TW' ? TW_INDEX : CN_INDEX_SH));
  if (idxMapSH.size === 0) throw new Error(`找不到指數本地K線（${market === 'TW' ? TW_INDEX : CN_INDEX_SH}）`);
  const idxMapSZ = market === 'CN' ? dateToCloseMap(await readRaw(dir, CN_INDEX_SZ)) : idxMapSH;
  const idxMapSZeff = idxMapSZ.size > 0 ? idxMapSZ : idxMapSH;

  const universe = await loadUniverse(market, dir);
  console.log(`[combo] ${market} universe ${universe.length} 檔｜起點 ${ENTRY_MIN_IDX} 根（黃控盤需 SUM(vol,480)）｜每檔最多取最近 ${days} 進場日｜lookback K=${K}`);

  const modelAcc = new Map<string, Acc>();
  const pushAcc = (id: string, f: Fwd) => {
    let a = modelAcc.get(id);
    if (!a) { a = mkAcc(); modelAcc.set(id, a); }
    if (f.d3 != null) a.d3.push(f.d3);
    if (f.d5 != null) a.d5.push(f.d5);
    if (f.d10 != null) a.d10.push(f.d10);
    if (f.d20 != null) a.d20.push(f.d20);
    a.mg.push(f.mg);
    a.ml.push(f.ml);
  };
  // 出場：M1(短線) / M4(中線) 兩個 cohort
  const exitAcc: Record<'M1' | 'M4', Map<ExitRule, { ret: number[]; hold: number[] }>> = {
    M1: new Map(), M4: new Map(),
  };
  const pushExit = (cohort: 'M1' | 'M4', rule: ExitRule, r: { ret: number; hold: number }) => {
    let m = exitAcc[cohort].get(rule);
    if (!m) { m = { ret: [], hold: [] }; exitAcc[cohort].set(rule, m); }
    m.ret.push(r.ret);
    m.hold.push(r.hold);
  };

  let stocksUsed = 0, stocksSkipped = 0, tradableBars = 0, limitUpExcluded = 0;
  let entryDateMin = '9999', entryDateMax = '0000';
  const jsonlLines: string[] = [];

  const BATCH = 80;
  for (let b = 0; b < universe.length; b += BATCH) {
    const batch = universe.slice(b, b + BATCH);
    const loaded = await Promise.all(batch.map((sym) => readRaw(dir, sym)));
    for (let k = 0; k < batch.length; k++) {
      const symbol = batch[k];
      const candles = loaded[k];
      if (!candles || candles.length < MIN_BARS) { stocksSkipped++; continue; }
      try {
        const homeIdx = market === 'CN' && symbol.endsWith('.SZ') ? idxMapSZeff : idxMapSH;
        let last = NaN;
        const indexClose = candles.map((c) => { const v = homeIdx.get(c.date); if (v != null) last = v; return last; });
        const g = computeSignals(candles, indexClose);
        const hi = g.n - 1 - FWD_WINDOW;                 // 進場上限：留滿 forward 窗
        const lo = Math.max(ENTRY_MIN_IDX, hi - days + 1); // 每檔取最近 days 個進場日
        if (hi < lo) { stocksSkipped++; continue; }
        let used = false;
        for (let i = lo; i <= hi; i++) {
          const f = forwardMetrics(g, i);
          if (!f) continue;
          if (!f.tradable) { limitUpExcluded++; continue; }
          tradableBars++;
          used = true;
          if (g.dates[i] < entryDateMin) entryDateMin = g.dates[i];
          if (g.dates[i] > entryDateMax) entryDateMax = g.dates[i];
          pushAcc('ALL', f);
          const hits = entryHits(g, i, K);
          for (const id of hits) pushAcc(id, f);
          // 出場 cohort
          if (hits.includes('M1')) for (const r of EXIT_RULES) pushExit('M1', r, exitFor(g, i, r));
          if (hits.includes('M4')) for (const r of EXIT_RULES) pushExit('M4', r, exitFor(g, i, r));
          // jsonl：只記命中核心模型的 bar（可事後再切）
          const core = hits.filter((h) => CORE_MODELS.has(h));
          if (core.length) {
            jsonlLines.push(JSON.stringify({ market, symbol, date: g.dates[i], models: hits, d3: f.d3, d5: f.d5, d10: f.d10, d20: f.d20, mg: f.mg, ml: f.ml }));
          }
        }
        if (used) stocksUsed++; else stocksSkipped++;
      } catch (e) {
        stocksSkipped++;
        console.error(`[combo] ${symbol} ✗ ${e instanceof Error ? e.message : e}`);
      }
    }
    if ((b / BATCH) % 5 === 0) console.log(`[combo] ${market} 進度 ${Math.min(b + BATCH, universe.length)}/${universe.length}｜用 ${stocksUsed} 檔｜可進場 ${tradableBars} 筆`);
  }

  const limitPct = tradableBars + limitUpExcluded > 0 ? (limitUpExcluded / (tradableBars + limitUpExcluded)) * 100 : 0;
  console.log(`[combo] ${market} 完成：用 ${stocksUsed} 檔 / 跳過 ${stocksSkipped}｜可進場 ${tradableBars} 筆｜漲停剔除 ${limitUpExcluded}（${limitPct.toFixed(1)}%）｜進場日 ${entryDateMin}~${entryDateMax}`);

  // ── 落地 ──
  const entryStats = MODEL_ORDER.filter((id) => modelAcc.has(id)).map((id) => {
    const a = modelAcc.get(id)!;
    return {
      id, label: LABELS[id] ?? id,
      d3: stat(a.d3), d5: stat(a.d5), d10: stat(a.d10), d20: stat(a.d20),
      maxGain: stat(a.mg), maxLoss: stat(a.ml),
    };
  });
  const exitStats: Record<string, unknown> = {};
  for (const cohort of ['M1', 'M4'] as const) {
    exitStats[cohort] = EXIT_RULES.filter((r) => exitAcc[cohort].has(r)).map((r) => {
      const m = exitAcc[cohort].get(r)!;
      const s = stat(m.ret);
      const h = stat(m.hold);
      return { rule: r, n: s.n, win: s.win, meanRet: s.mean, medianRet: s.median, meanHold: h.mean };
    });
  }
  const meta = { market, stamp, days, lookbackK: K, entryMinIdx: ENTRY_MIN_IDX, fwdWindow: FWD_WINDOW, stocksUsed, stocksSkipped, tradableBars, limitUpExcluded, limitPct: +limitPct.toFixed(1), entryDateMin, entryDateMax };

  await fs.writeFile(path.join(outDir, 'combo-entry-stats.json'), JSON.stringify({ meta, models: entryStats }), 'utf8');
  await fs.writeFile(path.join(outDir, 'combo-exit-stats.json'), JSON.stringify({ meta, cohorts: exitStats }), 'utf8');
  await fs.writeFile(path.join(outDir, 'combo-samples.jsonl'), jsonlLines.join('\n'), 'utf8');
  const report = buildReport(meta, entryStats, exitStats);
  await fs.writeFile(path.join(outDir, `combo-report-${stamp}.md`), report, 'utf8');
  console.log(`[combo] ${market} 已寫 → ${path.relative(process.cwd(), outDir)}/combo-{entry-stats.json,exit-stats.json,samples.jsonl,report-${stamp}.md}`);
  console.log('\n' + report);
}

// ── 報告 ────────────────────────────────────────────────────────
type EntryStat = { id: string; label: string; d3: ReturnType<typeof stat>; d5: ReturnType<typeof stat>; d10: ReturnType<typeof stat>; d20: ReturnType<typeof stat>; maxGain: ReturnType<typeof stat>; maxLoss: ReturnType<typeof stat> };

function buildReport(meta: any, models: EntryStat[], exitStats: Record<string, any>): string {
  const L: string[] = [];
  const mk = meta.market === 'TW' ? '台股' : '陸股';
  L.push(`# 三色 × 雙B × 捕撈 — ${mk}「使用順序」實證報告（${meta.stamp}）`);
  L.push('');
  L.push(`用 ${meta.stocksUsed} 檔（跳過 ${meta.stocksSkipped} 檔歷史不足 ${MIN_BARS} 根）｜可進場樣本 ${meta.tradableBars} 筆｜進場日 ${meta.entryDateMin} ~ ${meta.entryDateMax}`);
  L.push(`進場：隔日開盤｜漲停買不到剔除 ${meta.limitUpExcluded} 筆（${meta.limitPct}%）｜lookback K=${meta.lookbackK}`);
  L.push(`起點 ${meta.entryMinIdx} 根：黃(控盤)吃 SUM(vol,480) 需 ~480 根才有效，故所有模型同起點才公平。forward 窗 ${meta.fwdWindow} 交易日。`);
  L.push('');
  L.push(`> ⚠️ 三色是自創因子。台股選股正式路徑仍以書本規則為準（鐵則 #5）；此報告只評估三指標「搭配順序」有沒有 alpha。`);
  L.push('');

  const all = models.find((m) => m.id === 'ALL');
  const baseD5 = all?.d5.mean ?? null;
  const lift = (v: number | null | undefined) => (v == null || baseD5 == null ? '' : ` (${v - baseD5 > 0 ? '+' : ''}${(v - baseD5).toFixed(2)})`);

  L.push(`## A. 進場模型總表（平均報酬，括號內 d5 是相對全體基準的超額）`);
  L.push('');
  L.push(`| 模型 | n | 勝率(d5) | 平均d3 | 平均d5 | 平均d10 | 平均d20 | 平均最高 | 平均最低 |`);
  L.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const m of models) {
    const flag = m.id !== 'ALL' && m.d5.n < 30 ? ' ⚠n' : '';
    L.push(`| ${m.label}${flag} | ${m.d5.n} | ${fmt1(m.d5.win)}% | ${fmtPct(m.d3.mean)} | ${fmtPct(m.d5.mean)}${m.id !== 'ALL' ? lift(m.d5.mean) : ''} | ${fmtPct(m.d10.mean)} | ${fmtPct(m.d20.mean)} | ${fmtPct(m.maxGain.mean)} | ${fmtPct(m.maxLoss.mean)} |`);
  }
  L.push('');
  L.push(`> ⚠n = 樣本 < 30，僅供參考不下結論。「平均最高/最低」= forward ${meta.fwdWindow} 日窗內相對進場價的極值（停利/停損空間）。`);
  L.push('');

  // 中位數表（避免少數暴衝拉高平均）
  L.push(`## B. 進場模型中位數（中位報酬，比平均抗極端值）`);
  L.push('');
  L.push(`| 模型 | n | 中位d3 | 中位d5 | 中位d10 | 中位d20 |`);
  L.push(`|---|---:|---:|---:|---:|---:|`);
  for (const m of models) L.push(`| ${m.label} | ${m.d5.n} | ${fmtPct(m.d3.median)} | ${fmtPct(m.d5.median)} | ${fmtPct(m.d10.median)} | ${fmtPct(m.d20.median)} |`);
  L.push('');

  // 出場
  for (const cohort of ['M1', 'M4'] as const) {
    const rows = (exitStats[cohort] ?? []) as any[];
    const cname = cohort === 'M1' ? 'M1（紅＋捕撈金叉，短線）' : 'M4（紅＋黃＋觸發，中線）';
    L.push(`## C. 出場規則比較 — 進場樣本 = ${cname}`);
    L.push('');
    if (!rows.length) { L.push('（無樣本）'); L.push(''); continue; }
    L.push(`| 出場規則 | n | 勝率 | 平均報酬 | 中位報酬 | 平均持有K |`);
    L.push(`|---|---:|---:|---:|---:|---:|`);
    const RULE_LABEL: Record<string, string> = {
      cDead: '捕撈死叉', bDead: '雙B死叉', bBreakDn: '跌破智能交易線', mainWeak: '主力轉弱(紅翻負)',
      ma5: '跌破MA5(書本短線)', ma10: '跌破MA10(書本中線)', fixed5: '固定持有5日', fixed10: '固定持有10日',
    };
    for (const r of rows) L.push(`| ${RULE_LABEL[r.rule] ?? r.rule} | ${r.n} | ${fmt1(r.win)}% | ${fmtPct(r.meanRet)} | ${fmtPct(r.medianRet)} | ${fmt1(r.meanHold)} |`);
    L.push('');
  }

  // 自動 highlight
  const elig = models.filter((m) => m.id !== 'ALL' && !m.id.endsWith('_only') && m.id !== 'M0');
  const best = (horizon: 'd3' | 'd5' | 'd10' | 'd20', by: 'mean' | 'win') =>
    elig.filter((m) => m[horizon].n >= 30 && m[horizon][by] != null)
      .sort((a, b) => (b[horizon][by] as number) - (a[horizon][by] as number))[0];
  L.push(`## D. 自動摘要（n≥30 模型中最佳，供 playbook 起草）`);
  L.push('');
  const line = (h: 'd3' | 'd5' | 'd10' | 'd20') => {
    const bm = best(h, 'mean'); const bw = best(h, 'win');
    L.push(`- **${h}** 平均最高：${bm ? `${bm.label}（${fmtPct(bm[h].mean)}, n=${bm[h].n}）` : '—'}｜勝率最高：${bw ? `${bw.label}（${fmt1(bw[h].win)}%, n=${bw[h].n}）` : '—'}`);
  };
  line('d3'); line('d5'); line('d10'); line('d20');
  const m0 = models.find((m) => m.id === 'M0');
  if (m0 && all) L.push(`- 對照：M0 現行 flat-OR d5 平均 ${fmtPct(m0.d5.mean)}（n=${m0.d5.n}）｜全體基準 d5 平均 ${fmtPct(all.d5.mean)}（n=${all.d5.n}）`);
  L.push('');
  L.push(`> playbook 的文字結論由人看完 TW+CN 兩份報告後綜合撰寫（短線一套、中線一套），對照三份官方說明逐條驗證。`);
  return L.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
