// ============================================================
// 朱老師六條件 × 三色買訊 —— 「交集」實證回測（研究腳本，TW / CN 通用）
//
// 目的：統一排行榜已證明「台股三色強、陸股書本買法強」，但「六條件合格 ∩ 三色買訊」
//   的交集從沒測過——交集會縮樣本，1+1 是否 >2 必須用數據講話。
//
// 方法（沿用 scripts/research-sanse-combo.ts 同款框架，數字可直接對照）：
//   - 每檔載入完整 K 線一次：computeSanSe/computeDualB/computeXys 算三色逐日布林（O(N)）；
//     computeIndicators 後逐進場日呼叫 evaluateSixConditions（單一事實，鐵則 #10 不自刻）。
//   - 進場一律隔日開盤；漲停買不到（一字鎖死 / 跳空 ≥9.5%）剔除；起點 480 根（黃控盤需求）。
//   - cell：基準 / 六條件(5/6核心 與 6/6全齊) / 三色紅+觸發 / 交集 / 兩個差集（歸因用）。
//
// ⚠️ 三色是自創因子（鐵則 #5）：此腳本只供探索，不改 production 掃描、不接選股鏈路。
// ⚠️ 六條件門檻吃 ZHU_PURE_BOOK.thresholds（純書本版）；六條件設計給台股，CN 照套僅供參考。
//
// 用法：npx tsx scripts/backtest-zhu-sanse-intersection.ts [market=TW|CN] [days=480] [limit=0]
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { computeDualB, computeXys } from '@/lib/cn-sanse/dualB';
import { isNum } from '@/lib/cn-sanse/tdx';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { ZHU_PURE_BOOK } from '@/lib/strategy/StrategyConfig';
import type { Candle } from '@/types';

type Market = 'TW' | 'CN';

const FWD_WINDOW = 32;
const ENTRY_MIN_IDX = 480;    // 黃(midControl) 吃 SUM(vol,480) → 與 research-sanse-combo 同起點，數字可對照
const MIN_BARS = ENTRY_MIN_IDX + FWD_WINDOW + 8;
const LIMIT_GAP = 0.095;

const CN_INDEX_SH = '000001.SS';
const CN_INDEX_SZ = '399001.SZ';
const TW_INDEX = '^TWII';

// ── cell 定義 ───────────────────────────────────────────────────
const CELL_ORDER = ['ALL', 'ZHU5', 'ZHU6', 'SANSE', 'X5', 'X6', 'ZHU5_noS', 'SANSE_noZ'] as const;
type CellId = typeof CELL_ORDER[number];
const CELL_LABELS: Record<CellId, string> = {
  ALL: '全體可進場K棒（基準）',
  ZHU5: '六條件 核心5/6全過（書本進場日）',
  ZHU6: '六條件 6/6全齊（核心+指標）',
  SANSE: '三色 紅+觸發（紅亮＋雙B金叉/突破或捕撈金叉）',
  X5: '交集：六條件5/6 ∩ 三色紅+觸發',
  X6: '交集：六條件6/6 ∩ 三色紅+觸發',
  ZHU5_noS: '差集：六條件5/6 但無三色觸發',
  SANSE_noZ: '差集：三色紅+觸發 但六條件沒過',
};

// ── forward 報酬（與 research-sanse-combo.ts 同款語義） ─────────
interface Bars { n: number; dates: string[]; O: number[]; H: number[]; L: number[]; C: number[] }
interface Fwd { tradable: boolean; d3: number | null; d5: number | null; d10: number | null; d20: number | null; mg: number; ml: number }
function forwardMetrics(g: Bars, i: number): Fwd | null {
  if (i + 1 >= g.n) return null;
  const base = g.O[i + 1];
  if (!(base > 0)) return null;
  const eH = g.H[i + 1], eL = g.L[i + 1], eO = g.O[i + 1];
  const locked = eL > 0 && eO === eH && (eH - eL) / eL < 0.005;
  const gapUp = (g.O[i + 1] - g.C[i]) / g.C[i];
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
const fmtW = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)}%`);

// ── universe（與 research-sanse-combo.ts 同款） ────────────────
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

interface Acc { d3: number[]; d5: number[]; d10: number[]; d20: number[]; mg: number[]; ml: number[] }
const mkAcc = (): Acc => ({ d3: [], d5: [], d10: [], d20: [], mg: [], ml: [] });

async function main() {
  const market = (process.argv[2] ?? 'TW').toUpperCase() as Market;
  if (market !== 'TW' && market !== 'CN') throw new Error('market 只能 TW 或 CN');
  const days = parseInt(process.argv[3] ?? '480', 10) || 480;
  const limit = parseInt(process.argv[4] ?? '0', 10) || 0;
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = getLocalCandleDir(market);
  const outDir = path.join(process.cwd(), 'data', 'backtest-output');
  await fs.mkdir(outDir, { recursive: true });
  const thresholds = ZHU_PURE_BOOK.thresholds;

  const idxMapSH = dateToCloseMap(await readRaw(dir, market === 'TW' ? TW_INDEX : CN_INDEX_SH));
  if (idxMapSH.size === 0) throw new Error(`找不到指數本地K線（${market === 'TW' ? TW_INDEX : CN_INDEX_SH}）`);
  const idxMapSZ = market === 'CN' ? dateToCloseMap(await readRaw(dir, CN_INDEX_SZ)) : idxMapSH;
  const idxMapSZeff = idxMapSZ.size > 0 ? idxMapSZ : idxMapSH;

  let universe = await loadUniverse(market, dir);
  if (limit > 0) universe = universe.slice(0, limit);
  console.log(`[zhu∩sanse] ${market} universe ${universe.length} 檔｜起點 ${ENTRY_MIN_IDX} 根｜每檔最多 ${days} 進場日｜六條件門檻=ZHU_PURE_BOOK`);

  const cellAcc = new Map<CellId, Acc>();
  const pushAcc = (id: CellId, f: Fwd) => {
    let a = cellAcc.get(id);
    if (!a) { a = mkAcc(); cellAcc.set(id, a); }
    if (f.d3 != null) a.d3.push(f.d3);
    if (f.d5 != null) a.d5.push(f.d5);
    if (f.d10 != null) a.d10.push(f.d10);
    if (f.d20 != null) a.d20.push(f.d20);
    a.mg.push(f.mg);
    a.ml.push(f.ml);
  };

  let stocksUsed = 0, stocksSkipped = 0, tradableBars = 0, limitUpExcluded = 0, sixEvalCalls = 0;
  let entryDateMin = '9999', entryDateMax = '0000';
  const t0 = Date.now();

  const BATCH = 40;
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

        // 三色逐日布林（O(N) 一次算完）
        const s = computeSanSe(candles, indexClose);
        const red = s.midStrength.map((x) => isNum(x) && x > 0);
        const db = computeDualB(candles);
        const xys = computeXys(candles);

        // 六條件用的含指標 K 線（單一事實 computeIndicators + evaluateSixConditions）
        const ci = computeIndicators(candles);

        const g: Bars = {
          n: candles.length,
          dates: candles.map((c) => c.date),
          O: candles.map((c) => c.open), H: candles.map((c) => c.high),
          L: candles.map((c) => c.low), C: candles.map((c) => c.close),
        };
        const hi = g.n - 1 - FWD_WINDOW;
        const lo = Math.max(ENTRY_MIN_IDX, hi - days + 1);
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

          const sanseBuy = red[i] && (db.goldCross[i] || db.breakUp[i] || xys.goldCross[i]);

          // 條件⑤要求紅K（收>開），收≤開必不過核心 → 安全省呼叫；其餘一律走單一事實函式
          let zhu5 = false, zhu6 = false;
          if (g.C[i] > g.O[i]) {
            sixEvalCalls++;
            const six = evaluateSixConditions(ci, i, thresholds);
            zhu5 = six.isCoreReady;
            zhu6 = six.isCoreReady && six.totalScore === 6;
          }

          pushAcc('ALL', f);
          if (zhu5) pushAcc('ZHU5', f);
          if (zhu6) pushAcc('ZHU6', f);
          if (sanseBuy) pushAcc('SANSE', f);
          if (zhu5 && sanseBuy) pushAcc('X5', f);
          if (zhu6 && sanseBuy) pushAcc('X6', f);
          if (zhu5 && !sanseBuy) pushAcc('ZHU5_noS', f);
          if (sanseBuy && !zhu5) pushAcc('SANSE_noZ', f);
        }
        if (used) stocksUsed++; else stocksSkipped++;
      } catch (e) {
        stocksSkipped++;
        console.error(`[zhu∩sanse] ${symbol} ✗ ${e instanceof Error ? e.message : e}`);
      }
    }
    if ((b / BATCH) % 5 === 0) {
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`[zhu∩sanse] ${market} 進度 ${Math.min(b + BATCH, universe.length)}/${universe.length}｜用 ${stocksUsed} 檔｜可進場 ${tradableBars}｜${el}s`);
    }
  }

  const limitPct = tradableBars + limitUpExcluded > 0 ? (limitUpExcluded / (tradableBars + limitUpExcluded)) * 100 : 0;
  console.log(`[zhu∩sanse] ${market} 完成：用 ${stocksUsed} 檔 / 跳過 ${stocksSkipped}｜可進場 ${tradableBars}｜漲停剔除 ${limitUpExcluded}（${limitPct.toFixed(1)}%）｜六條件評估 ${sixEvalCalls} 次｜進場日 ${entryDateMin}~${entryDateMax}`);

  // ── 報告 ──
  const allAcc = cellAcc.get('ALL');
  const baseD5 = allAcc ? stat(allAcc.d5).mean : null;
  const rows = CELL_ORDER.filter((id) => cellAcc.has(id)).map((id) => {
    const a = cellAcc.get(id)!;
    const d3 = stat(a.d3), d5 = stat(a.d5), d10 = stat(a.d10), d20 = stat(a.d20);
    const mg = stat(a.mg), ml = stat(a.ml);
    const excess = d5.mean != null && baseD5 != null ? d5.mean - baseD5 : null;
    return { id, label: CELL_LABELS[id], d3, d5, d10, d20, mg, ml, excess };
  });

  const lines: string[] = [];
  lines.push(`# 朱老師六條件 × 三色買訊 — 交集回測（${market}，${stamp}）`);
  lines.push('');
  lines.push(`用 ${stocksUsed} 檔（跳過 ${stocksSkipped}）｜可進場樣本 ${tradableBars} 筆｜進場日 ${entryDateMin} ~ ${entryDateMax}`);
  lines.push(`進場：隔日開盤｜漲停買不到剔除 ${limitUpExcluded} 筆（${limitPct.toFixed(1)}%）｜起點 480 根（與 combo-report 同，數字可直接對照）`);
  lines.push(`六條件＝evaluateSixConditions + ZHU_PURE_BOOK 門檻（單一事實重算，非讀掃描紀錄）；「5/6」＝核心五條全過(isCoreReady)、「6/6」＝外加指標條件。`);
  lines.push(`三色買訊＝SOP 的「紅+觸發」：主力狀態紅>0 ＋（雙B黃紅金叉 或 突破智能線 或 捕撈金叉）。`);
  lines.push('');
  if (market === 'CN') lines.push('> ⚠️ 六條件是台股書本規則，CN 照套僅供參考（K棒/量能行為不同）。');
  lines.push('> ⚠️ 本地 K 只含現存代號 → 存活偏差，結論偏樂觀；三色為自創因子（鐵則 #5），本報告不改 production。');
  lines.push('');
  lines.push('## 進場 cell 總表（平均報酬；交集是否 1+1>2 看 X5/X6 對 ZHU5/SANSE 的差）');
  lines.push('');
  lines.push('| cell | n(d5) | 勝率(d5) | 平均d3 | 平均d5 | 超額d5 vs 基準 | 平均d10 | 平均d20 | 平均最高 | 平均最低 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    lines.push(`| ${r.label} | ${r.d5.n} | ${fmtW(r.d5.win)} | ${fmtPct(r.d3.mean)} | ${fmtPct(r.d5.mean)} | ${r.excess == null ? '—' : fmtPct(r.excess)} | ${fmtPct(r.d10.mean)} | ${fmtPct(r.d20.mean)} | ${fmtPct(r.mg.mean)} | ${fmtPct(r.ml.mean)} |`);
  }
  lines.push('');
  lines.push('## 中位數（抗極端值）');
  lines.push('');
  lines.push('| cell | 中位d3 | 中位d5 | 中位d10 | 中位d20 |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const r of rows) {
    lines.push(`| ${r.label} | ${fmtPct(r.d3.median)} | ${fmtPct(r.d5.median)} | ${fmtPct(r.d10.median)} | ${fmtPct(r.d20.median)} |`);
  }
  lines.push('');
  const x5 = rows.find((r) => r.id === 'X5'), z5 = rows.find((r) => r.id === 'ZHU5'), ss = rows.find((r) => r.id === 'SANSE');
  if (x5 && z5 && ss && x5.d5.mean != null && z5.d5.mean != null && ss.d5.mean != null) {
    lines.push('## 自動摘要');
    lines.push('');
    lines.push(`- 六條件5/6 單獨：d5 ${fmtPct(z5.d5.mean)}（勝率 ${fmtW(z5.d5.win)}，n=${z5.d5.n}）`);
    lines.push(`- 三色紅+觸發 單獨：d5 ${fmtPct(ss.d5.mean)}（勝率 ${fmtW(ss.d5.win)}，n=${ss.d5.n}）`);
    lines.push(`- 交集：d5 ${fmtPct(x5.d5.mean)}（勝率 ${fmtW(x5.d5.win)}，n=${x5.d5.n}）`);
    const better = x5.d5.mean > Math.max(z5.d5.mean, ss.d5.mean);
    lines.push(`- 交集是否同時勝過兩邊單獨用（d5 平均）：**${better ? '是 ✅' : '否 ❌'}**`);
  }
  lines.push('');

  const outPath = path.join(outDir, `zhu-sanse-intersection-${market}-${stamp}.md`);
  await fs.writeFile(outPath, lines.join('\n'), 'utf8');
  const jsonPath = path.join(outDir, `zhu-sanse-intersection-${market}-${stamp}.json`);
  await fs.writeFile(jsonPath, JSON.stringify({ market, stamp, days, stocksUsed, stocksSkipped, tradableBars, limitUpExcluded, entryDateMin, entryDateMax, rows }, null, 1), 'utf8');
  console.log(`[zhu∩sanse] 報告 → ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
