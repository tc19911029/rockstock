// ============================================================
// 五指標融合進場訊號 —— 誠實 edge 實證（研究腳本，TW / CN）
//
// 目的：把 MACD + KD + 捕撈季節(XYS) + 雙B戰法 + 主力狀態 融合成一個「進場分數」，
//   驗證融合後到底有沒有「比單獨用每個指標、比大盤」更準。
//
// 誠實紀律（對齊 CLAUDE.md「誠實 edge」+ 記憶 honest_edge）：
//   1. 報酬一律「超額」= 個股(隔日開→close[i+1+k]) − 大盤同窗(close[i+1]→close[i+1+k])。
//      raw 報酬含大盤 beta，不能當 alpha。
//   2. 扣交易成本 COST_PCT（來回約 0.5%）。
//   3. train/test 分半（依進場日中位數切）— 兩半都要正、且方向一致，才算可能有 edge。
//   4. 漲停買不到（隔日一字/追停跳空 ≥9.5%）剔除，避免倖存者偏差。
//   5. 不做 grid search（多重檢定=假發現）。只測「理論預先指定」的少數融合規則 + 單指標基準。
//
// ⚠️ 自創因子（鐵則 #5/#10）：只供研究，不改 production 掃描、不接選股鏈路。
//    是否 promote 由使用者看完報告決定。
//
// 用法：npx tsx scripts/research-fusion-indicator.ts [market=TW|CN] [days=480]
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { computeDualB, computeXys } from '@/lib/cn-sanse/dualB';
import { computeIndicators } from '@/lib/indicators';
import { MA, isNum } from '@/lib/cn-sanse/tdx';
import type { Candle } from '@/types';

type Market = 'TW' | 'CN';

const FWD_WINDOW = 24;
const ENTRY_MIN_IDX = 480;            // 黃(midControl) 吃 SUM(vol,480)
const MIN_BARS = ENTRY_MIN_IDX + FWD_WINDOW + 8;
const LIMIT_GAP = 0.095;
const COST_PCT = 0.5;                 // 來回交易成本（%）— TW 證交稅0.3%+手續費折讓 ≈ 0.5%
const HORIZONS = [5, 20] as const;    // 短線 d5 + 中線 d20

// ── 逐根訊號 ─────────────────────────────────────────────
interface Sig {
  n: number; dates: string[];
  O: number[]; H: number[]; L: number[]; C: number[];
  red: boolean[];        // 主力狀態：中線強勢>0（門票）
  yellow: boolean[];     // 主力狀態：中線控盤>0
  cGold: boolean[]; xAbove0: boolean[]; xBelow0: boolean[];   // 捕撈
  bGold: boolean[]; bBreak: boolean[]; aboveMa60: boolean[];  // 雙B
  macdGold: boolean[]; macdOscPos: boolean[]; macdDifPos: boolean[]; // MACD
  kdGold: boolean[]; kdNotOB: boolean[]; kdLow: boolean[];    // KD
}

function computeSignals(candles: Candle[], indexClose: number[]): Sig {
  const n = candles.length;
  const O = candles.map((c) => c.open), H = candles.map((c) => c.high);
  const L = candles.map((c) => c.low), C = candles.map((c) => c.close);
  const dates = candles.map((c) => c.date);

  // 主力狀態
  const s = computeSanSe(candles, indexClose);
  const red = s.midStrength.map((x) => isNum(x) && x > 0);
  const yellow = s.midControl.map((x) => isNum(x) && x > 0);

  // 捕撈
  const xys = computeXys(candles);
  const cGold = xys.goldCross;
  const xAbove0 = xys.xys1.map((x) => isNum(x) && x > 0);
  const xBelow0 = xys.xys1.map((x) => isNum(x) && x < 0);

  // 雙B
  const db = computeDualB(candles);
  const bGold = db.goldCross, bBreak = db.breakUp;
  const ma60 = db.ma60;
  const aboveMa60 = C.map((c, i) => isNum(ma60[i]) && c > ma60[i]);

  // MACD + KD（用 production computeIndicators，與走圖同源）
  const ind = computeIndicators(candles) as any[];
  const dif = ind.map((r) => r.macdDIF as number | undefined);
  const sigl = ind.map((r) => r.macdSignal as number | undefined);
  const osc = ind.map((r) => r.macdOSC as number | undefined);
  const kK = ind.map((r) => r.kdK as number | undefined);
  const kD = ind.map((r) => r.kdD as number | undefined);
  const macdGold = ind.map((_, i) => i > 0 && dif[i] != null && sigl[i] != null && dif[i - 1] != null && sigl[i - 1] != null && (dif[i - 1] as number) <= (sigl[i - 1] as number) && (dif[i] as number) > (sigl[i] as number));
  const macdOscPos = osc.map((o) => o != null && o > 0);
  const macdDifPos = dif.map((d) => d != null && d > 0);
  const kdGold = ind.map((_, i) => i > 0 && kK[i] != null && kD[i] != null && kK[i - 1] != null && kD[i - 1] != null && (kK[i - 1] as number) <= (kD[i - 1] as number) && (kK[i] as number) > (kD[i] as number));
  const kdNotOB = kK.map((k) => k != null && k < 80);     // 非超買
  const kdLow = kK.map((k) => k != null && k < 50);       // 低檔（給金叉加分用）

  return { n, dates, O, H, L, C, red, yellow, cGold, xAbove0, xBelow0, bGold, bBreak, aboveMa60, macdGold, macdOscPos, macdDifPos, kdGold, kdNotOB, kdLow };
}

// ── 融合規則（理論預先指定，不 grid search） ─────────────────
// trigger = 時機層（捕撈金叉 或 雙B金叉/突破）
const RULES: { id: string; label: string; hit: (g: Sig, i: number) => boolean }[] = [
  // 單指標基準
  { id: 's_red', label: '單·主力中線強勢(紅)', hit: (g, i) => g.red[i] },
  { id: 's_catch', label: '單·捕撈金叉', hit: (g, i) => g.cGold[i] },
  { id: 's_dualb', label: '單·雙B金叉/突破', hit: (g, i) => g.bGold[i] || g.bBreak[i] },
  { id: 's_macd', label: '單·MACD金叉', hit: (g, i) => g.macdGold[i] },
  { id: 's_kd', label: '單·KD金叉', hit: (g, i) => g.kdGold[i] },
  // 融合
  { id: 'f_timing', label: '融合·時機(捕撈或雙B金叉)', hit: (g, i) => g.cGold[i] || g.bGold[i] || g.bBreak[i] },
  { id: 'f_gate_timing', label: '融合·門票(紅)+時機', hit: (g, i) => g.red[i] && (g.cGold[i] || g.bGold[i] || g.bBreak[i]) },
  { id: 'f_gate_timing_macd', label: '融合·紅+時機+MACD柱>0', hit: (g, i) => g.red[i] && (g.cGold[i] || g.bGold[i] || g.bBreak[i]) && g.macdOscPos[i] },
  { id: 'f_confirm', label: '融合·紅+時機+MACD柱>0+KD未超買', hit: (g, i) => g.red[i] && (g.cGold[i] || g.bGold[i] || g.bBreak[i]) && g.macdOscPos[i] && g.kdNotOB[i] },
  { id: 'f_all5_strict', label: '融合·五線齊揚(紅+捕撈金叉+雙B+MACD金叉+KD金叉)', hit: (g, i) => g.red[i] && g.cGold[i] && (g.bGold[i] || g.bBreak[i]) && (g.macdGold[i] || g.macdOscPos[i]) && (g.kdGold[i] || g.kdNotOB[i]) },
  { id: 'f_dip', label: '融合·紅+捕撈空頭區金叉+KD低檔(底部反彈)', hit: (g, i) => g.red[i] && g.cGold[i] && g.xBelow0[i] && g.kdLow[i] },
];

// ── forward 超額報酬 ─────────────────────────────────────
interface Fwd { tradable: boolean; ex: Record<number, number | null>; }
function forwardMetrics(g: Sig, idx: number[], i: number): Fwd | null {
  if (i + 1 >= g.n) return null;
  const base = g.O[i + 1];
  if (!(base > 0)) return null;
  const idxBase = idx[i + 1];
  const eH = g.H[i + 1], eL = g.L[i + 1], eO = g.O[i + 1];
  const locked = eL > 0 && eO === eH && (eH - eL) / eL < 0.005;
  const gapUp = (g.O[i + 1] - g.C[i]) / g.C[i];
  const tradable = !(locked || gapUp >= LIMIT_GAP);
  const ex: Record<number, number | null> = {};
  for (const k of HORIZONS) {
    const j = i + 1 + (k - 1);
    if (j < g.n && isNum(idxBase) && idxBase! > 0 && isNum(idx[j])) {
      const stockRet = ((g.C[j] - base) / base) * 100;
      const idxRet = ((idx[j] - idxBase!) / idxBase!) * 100;
      ex[k] = +(stockRet - idxRet).toFixed(3);          // 超額（未扣成本）
    } else ex[k] = null;
  }
  return { tradable, ex };
}

// ── 統計 ─────────────────────────────────────────────────
function stat(xs: number[]) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0, mean: null as number | null, win: null as number | null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const win = (v.filter((x) => x > 0).length / v.length) * 100;
  return { n: v.length, mean, win };
}
const fp = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const fw = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(0)}%`);

// ── universe ─────────────────────────────────────────────
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
const CN_INDEX_SH = '000001.SS', CN_INDEX_SZ = '399001.SZ', TW_INDEX = '^TWII';
function isCommonTw(file: string): boolean {
  const m = file.match(/^(\d{4})\.(TW|TWO)\.json$/);
  if (!m) return false;
  if (m[1].startsWith('00')) return false;
  return true;
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
    if (isExcludedCn(s.symbol, s.name)) continue;
    if (seen.has(s.symbol)) continue;
    seen.add(s.symbol); out.push(s.symbol);
  }
  return out;
}
function dateToCloseMap(cs: Candle[] | null): Map<string, number> {
  const m = new Map<string, number>();
  if (cs) for (const c of cs) m.set(c.date, c.close);
  return m;
}

// ── 主流程 ───────────────────────────────────────────────
type Bucket = { ex: Record<number, number[]> };
const mkBucket = (): Bucket => ({ ex: Object.fromEntries(HORIZONS.map((k) => [k, [] as number[]])) });

async function main() {
  const market = (process.argv[2] ?? 'TW').toUpperCase() as Market;
  if (market !== 'TW' && market !== 'CN') throw new Error('market 只能 TW 或 CN');
  const days = parseInt(process.argv[3] ?? '480', 10) || 480;
  const dir = getLocalCandleDir(market);

  const idxMapSH = dateToCloseMap(await readRaw(dir, market === 'TW' ? TW_INDEX : CN_INDEX_SH));
  if (idxMapSH.size === 0) throw new Error('找不到指數本地K線');
  const idxMapSZ = market === 'CN' ? dateToCloseMap(await readRaw(dir, CN_INDEX_SZ)) : idxMapSH;
  const idxMapSZeff = idxMapSZ.size > 0 ? idxMapSZ : idxMapSH;

  const universe = await loadUniverse(market, dir);
  console.log(`[fusion] ${market} universe ${universe.length} 檔｜每檔最近 ${days} 進場日｜超額 vs 大盤｜成本 ${COST_PCT}%`);

  // 先收集所有命中（含進場日），再依日期中位數切 train/test
  type Rec = { rule: string; date: string; ex: Record<number, number | null> };
  const recs: Rec[] = [];
  const allDates: string[] = [];

  let stocksUsed = 0, tradableBars = 0, limitUpExcluded = 0;
  const BATCH = 80;
  for (let b = 0; b < universe.length; b += BATCH) {
    const batch = universe.slice(b, b + BATCH);
    const loaded = await Promise.all(batch.map((sym) => readRaw(dir, sym)));
    for (let k = 0; k < batch.length; k++) {
      const symbol = batch[k]; const candles = loaded[k];
      if (!candles || candles.length < MIN_BARS) continue;
      try {
        const homeIdx = market === 'CN' && symbol.endsWith('.SZ') ? idxMapSZeff : idxMapSH;
        let last = NaN;
        const indexClose = candles.map((c) => { const v = homeIdx.get(c.date); if (v != null) last = v; return last; });
        const g = computeSignals(candles, indexClose);
        const hi = g.n - 1 - FWD_WINDOW;
        const lo = Math.max(ENTRY_MIN_IDX, hi - days + 1);
        if (hi < lo) continue;
        let used = false;
        for (let i = lo; i <= hi; i++) {
          const f = forwardMetrics(g, indexClose, i);
          if (!f) continue;
          if (!f.tradable) { limitUpExcluded++; continue; }
          tradableBars++; used = true;
          allDates.push(g.dates[i]);
          for (const r of RULES) if (r.hit(g, i)) recs.push({ rule: r.id, date: g.dates[i], ex: f.ex });
          recs.push({ rule: 'ALL', date: g.dates[i], ex: f.ex });
        }
        if (used) stocksUsed++;
      } catch (e) { console.error(`[fusion] ${symbol} ✗ ${e instanceof Error ? e.message : e}`); }
    }
    if ((b / BATCH) % 5 === 0) console.log(`[fusion] 進度 ${Math.min(b + BATCH, universe.length)}/${universe.length}｜可進場 ${tradableBars}`);
  }

  allDates.sort();
  const splitDate = allDates[Math.floor(allDates.length / 2)];
  console.log(`[fusion] 完成：用 ${stocksUsed} 檔｜可進場 ${tradableBars}｜漲停剔除 ${limitUpExcluded}｜train/test 切點 ${splitDate}`);

  // 分桶：rule → period(train/test/all) → bucket
  const acc = new Map<string, { all: Bucket; train: Bucket; test: Bucket }>();
  for (const rec of recs) {
    let a = acc.get(rec.rule);
    if (!a) { a = { all: mkBucket(), train: mkBucket(), test: mkBucket() }; acc.set(rec.rule, a); }
    for (const k of HORIZONS) {
      const v = rec.ex[k];
      if (v == null) continue;
      a.all.ex[k].push(v);
      (rec.date < splitDate ? a.train : a.test).ex[k].push(v);
    }
  }

  const ORDER = ['ALL', ...RULES.map((r) => r.id)];
  const LABEL: Record<string, string> = { ALL: '全體可進場K棒(大盤基準)', ...Object.fromEntries(RULES.map((r) => [r.id, r.label])) };

  // 報告
  const stamp = new Date().toISOString().slice(0, 10);
  const L: string[] = [];
  L.push(`# 五指標融合進場訊號 — ${market === 'TW' ? '台股' : '陸股'} 誠實 edge 報告（${stamp}）`);
  L.push('');
  L.push(`- 報酬＝**超額**（個股 隔日開→第N日收 − 大盤同窗）；門檻：扣 ${COST_PCT}% 成本後仍要正`);
  L.push(`- universe ${universe.length} 檔 / 用 ${stocksUsed} 檔；可進場 ${tradableBars} 筆；漲停剔除 ${limitUpExcluded}`);
  L.push(`- train/test 依進場日中位數 **${splitDate}** 切半（前=train 後=test）`);
  L.push('');
  for (const k of HORIZONS) {
    L.push(`## d${k} 超額報酬（扣 ${COST_PCT}% 成本）`);
    L.push('');
    L.push('| 規則 | 全期 樣本 | 全期 超額 | 全期 勝率 | train 超額 | test 超額 | train/test 一致? |');
    L.push('|---|---:|---:|---:|---:|---:|:--:|');
    for (const id of ORDER) {
      const a = acc.get(id);
      if (!a) continue;
      const sa = stat(a.all.ex[k]), st = stat(a.train.ex[k]), se = stat(a.test.ex[k]);
      if (sa.n < 30) continue;       // 樣本太少不列
      const net = (m: number | null) => (m == null ? null : m - COST_PCT);
      const naAll = net(sa.mean), naTr = net(st.mean), naTe = net(se.mean);
      const consistent = naTr != null && naTe != null && naTr > 0 && naTe > 0 ? '✅ 都正' : (naTr != null && naTe != null && naTr < 0 && naTe < 0 ? '❌ 都負' : '⚠️ 不一致');
      L.push(`| ${LABEL[id]} | ${sa.n} | ${fp(naAll)} | ${fw(sa.win)} | ${fp(naTr)} | ${fp(naTe)} | ${consistent} |`);
    }
    L.push('');
  }
  L.push('> 判讀：要「全期正 + train 與 test 都正」才算可能有 edge；只要 test 翻負或 train/test 不一致 = 過擬合，不可上線。');

  const outDir = path.join(process.cwd(), 'data', market === 'TW' ? 'tw-sanse' : 'cn-sanse');
  await fs.mkdir(outDir, { recursive: true });
  const report = L.join('\n');
  await fs.writeFile(path.join(outDir, `fusion-report-${market}-${stamp}.md`), report, 'utf8');
  console.log(`[fusion] 已寫 → ${path.relative(process.cwd(), outDir)}/fusion-report-${market}-${stamp}.md`);
  console.log('\n' + report);
}

main().catch((e) => { console.error(e); process.exit(1); });
