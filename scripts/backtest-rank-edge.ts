// ============================================================
// 排序 edge 回測 —— 「每日在三色訊號池裡取前 N 名，到底有沒有把贏家排前面」
//
// 前一支 backtest-daily-pick 證明：單一過濾條件(末升段)大多邊際甚至反向。
// 那 daily-pick 真正可能賺錢的地方在哪？= 「排序取最前面 1-2 檔」。本腳本驗證它。
//
// 做法（無未來偏誤，與 zhu-sanse-intersection / daily-pick 同框架）：
//   每個交易日 T，跨全市場找出「三色紅+觸發」的候選池 → 依排序鍵取 top1/3/5 →
//   隔日(T+1)開盤進場 → 量 d1/d3/d5/d20 收盤報酬。
//   cohort = 當日候選池全體（與排序無關的基準）。
//   排序alpha = topN 平均 − cohort 平均；>0 才代表「排序真的把贏家排前面」。
//   比較三個排序鍵：①當日漲幅 ②六條件總分 ③短攻強度(三色 shortAttack)。
//
// 無未來偏誤：訊號/排序鍵全用 candles[0..i]；進場 i+1 開盤；漲停買不到剔除；
//   未來棒只算報酬。每日 top-N 是「站在 T 收盤」依當日可見資訊排序，不碰 T+1 之後。
//
// ⚠️ 三色自創因子，研究用不改 production（鐵則 #5）。本地 K 存活偏差→絕對值偏樂觀，
//    重點看「topN vs cohort 的排序alpha」相對差。
//
// 用法：npx tsx scripts/backtest-rank-edge.ts [days=480] [limit=0]
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

const FWD_WINDOW = 32;
const ENTRY_MIN_IDX = 480;
const MIN_BARS = ENTRY_MIN_IDX + FWD_WINDOW + 8;
const LIMIT_GAP = 0.095;
const TW_INDEX = '^TWII';

interface Entry {
  symbol: string;
  date: string;
  changePct: number;   // 排序鍵①：當日漲幅
  sixTotal: number;    // 排序鍵②：六條件總分(0-6)
  shortAttack: number; // 排序鍵③：三色短攻強度
  d1: number | null; d3: number | null; d5: number | null; d20: number | null;
  mg: number; ml: number;
}

function forwardOf(g: { n: number; O: number[]; H: number[]; L: number[]; C: number[] }, i: number) {
  if (i + 1 >= g.n) return null;
  const base = g.O[i + 1];
  if (!(base > 0)) return null;
  const eH = g.H[i + 1], eL = g.L[i + 1], eO = g.O[i + 1];
  const locked = eL > 0 && eO === eH && (eH - eL) / eL < 0.005;
  const gapUp = (g.O[i + 1] - g.C[i]) / g.C[i];
  if (locked || gapUp >= LIMIT_GAP) return null; // 漲停買不到 → 剔除
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
  return { d1: closeRet(0), d3: closeRet(2), d5: closeRet(4), d20: closeRet(19), mg: +mg.toFixed(3), ml: +ml.toFixed(3) };
}

function stat(xs: number[]) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0, mean: null as number | null, win: null as number | null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const win = (v.filter((x) => x > 0).length / v.length) * 100;
  return { n: v.length, mean, win };
}
const fmtPct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const fmtW = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)}%`);

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
function dateToCloseMap(cs: Candle[] | null): Map<string, number> {
  const m = new Map<string, number>();
  if (cs) for (const c of cs) m.set(c.date, c.close);
  return m;
}

// 排序鍵定義（站在 T 收盤可見）
type RankKey = 'chg' | 'six' | 'attack';
const RANK_LABEL: Record<RankKey, string> = {
  chg: '當日漲幅', six: '六條件總分', attack: '三色短攻強度',
};
function rankValue(e: Entry, key: RankKey): number {
  return key === 'chg' ? e.changePct : key === 'six' ? e.sixTotal : e.shortAttack;
}

async function main() {
  const days = parseInt(process.argv[2] ?? '480', 10) || 480;
  const limit = parseInt(process.argv[3] ?? '0', 10) || 0;
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = getLocalCandleDir('TW');
  const outDir = path.join(process.cwd(), 'data', 'backtest-output');
  await fs.mkdir(outDir, { recursive: true });
  const thresholds = ZHU_PURE_BOOK.thresholds;

  const idxMap = dateToCloseMap(await readRaw(dir, TW_INDEX));
  if (idxMap.size === 0) throw new Error(`找不到指數本地K線（${TW_INDEX}）`);

  let universe = (await fs.readdir(dir)).filter(isCommonTw).map((f) => f.replace(/\.json$/, ''));
  if (limit > 0) universe = universe.slice(0, limit);
  console.log(`[rank-edge] TW universe ${universe.length} 檔｜訊號池=三色紅+觸發｜起點 ${ENTRY_MIN_IDX} 根`);

  // date → 當日所有三色訊號候選（之後跨股排序取 top-N）
  const byDate = new Map<string, Entry[]>();
  let stocksUsed = 0, stocksSkipped = 0, totalSignals = 0;
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
        let last = NaN;
        const indexClose = candles.map((c) => { const v = idxMap.get(c.date); if (v != null) last = v; return last; });
        const s = computeSanSe(candles, indexClose);
        const red = s.midStrength.map((x) => isNum(x) && x > 0);
        const shortAttackArr = s.shortAttack;
        const db = computeDualB(candles);
        const xys = computeXys(candles);
        const ci = computeIndicators(candles);

        const g = {
          n: candles.length,
          O: candles.map((c) => c.open), H: candles.map((c) => c.high),
          L: candles.map((c) => c.low), C: candles.map((c) => c.close),
        };
        const hi = g.n - 1 - FWD_WINDOW;
        const lo = Math.max(ENTRY_MIN_IDX, hi - days + 1);
        if (hi < lo) { stocksSkipped++; continue; }
        let used = false;
        for (let i = lo; i <= hi; i++) {
          const sanseBuy = red[i] && (db.goldCross[i] || db.breakUp[i] || xys.goldCross[i]);
          if (!sanseBuy) continue;
          const fwd = forwardOf(g, i);
          if (!fwd) continue; // 漲停買不到/無未來棒
          used = true;
          totalSignals++;
          const changePct = i > 0 && g.C[i - 1] > 0 ? ((g.C[i] - g.C[i - 1]) / g.C[i - 1]) * 100 : 0;
          let sixTotal = 0;
          if (g.C[i] > g.O[i]) sixTotal = evaluateSixConditions(ci, i, thresholds).totalScore;
          const date = candles[i].date;
          const e: Entry = {
            symbol, date, changePct, sixTotal,
            shortAttack: isNum(shortAttackArr[i]) ? shortAttackArr[i] : 0,
            d1: fwd.d1, d3: fwd.d3, d5: fwd.d5, d20: fwd.d20, mg: fwd.mg, ml: fwd.ml,
          };
          const arr = byDate.get(date);
          if (arr) arr.push(e); else byDate.set(date, [e]);
        }
        if (used) stocksUsed++; else stocksSkipped++;
      } catch (e) {
        stocksSkipped++;
        console.error(`[rank-edge] ${symbol} ✗ ${e instanceof Error ? e.message : e}`);
      }
    }
    if ((b / BATCH) % 5 === 0) {
      console.log(`[rank-edge] 進度 ${Math.min(b + BATCH, universe.length)}/${universe.length}｜訊號 ${totalSignals}｜${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  const dates = [...byDate.keys()].sort();
  console.log(`[rank-edge] 完成：用 ${stocksUsed} 檔｜訊號 ${totalSignals} 筆｜有訊號交易日 ${dates.length}（${dates[0]} ~ ${dates[dates.length - 1]}）`);

  // ── 每日 top-N 排序（站在 T 收盤可見資訊）──
  type Bucket = { d1: number[]; d3: number[]; d5: number[]; d20: number[]; mg: number[]; ml: number[] };
  const mk = (): Bucket => ({ d1: [], d3: [], d5: [], d20: [], mg: [], ml: [] });
  const push = (bk: Bucket, e: Entry) => {
    if (e.d1 != null) bk.d1.push(e.d1); if (e.d3 != null) bk.d3.push(e.d3);
    if (e.d5 != null) bk.d5.push(e.d5); if (e.d20 != null) bk.d20.push(e.d20);
    bk.mg.push(e.mg); bk.ml.push(e.ml);
  };

  const cohort = mk();
  for (const d of dates) for (const e of byDate.get(d)!) push(cohort, e);

  const lines: string[] = [];
  lines.push(`# 排序 edge 回測 — 三色訊號池每日取前 N 名（TW，${stamp}）`);
  lines.push('');
  lines.push(`用 ${stocksUsed} 檔｜三色紅+觸發訊號 ${totalSignals} 筆｜有訊號交易日 ${dates.length}（${dates[0]} ~ ${dates[dates.length - 1]}）`);
  lines.push(`進場：隔日開盤｜漲停買不到剔除｜訊號/排序鍵只用當日前資料（無未來偏誤）`);
  lines.push('');
  lines.push('> ⚠️ 本地 K 存活偏差 → 絕對值偏樂觀；看 topN vs cohort 的「排序alpha」相對差。');
  lines.push('> ⚠️ 三色自創因子，研究用不改 production（鐵則 #5）。');
  lines.push('');

  const coD5 = stat(cohort.d5);
  for (const key of ['chg', 'six', 'attack'] as RankKey[]) {
    const top1 = mk(), top3 = mk(), top5 = mk();
    for (const d of dates) {
      const cands = [...byDate.get(d)!].sort((a, b) => rankValue(b, key) - rankValue(a, key));
      cands.slice(0, 1).forEach((e) => push(top1, e));
      cands.slice(0, 3).forEach((e) => push(top3, e));
      cands.slice(0, 5).forEach((e) => push(top5, e));
    }
    const t1 = stat(top1.d5), t3 = stat(top3.d5), t5 = stat(top5.d5);
    const t1d1 = stat(top1.d1), t1d3 = stat(top1.d3), t1d20 = stat(top1.d20);
    const alpha = t1.mean != null && coD5.mean != null ? t1.mean - coD5.mean : null;
    lines.push(`## 排序鍵：${RANK_LABEL[key]}`);
    lines.push('');
    lines.push('| 選股單位 | n(d5) | 勝率(d5) | d1 | d3 | d5 | d20 | 排序alpha(d5 vs cohort) |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    lines.push(`| **top1**(每日第1名) | ${t1.n} | ${fmtW(t1.win)} | ${fmtPct(t1d1.mean)} | ${fmtPct(t1d3.mean)} | **${fmtPct(t1.mean)}** | ${fmtPct(t1d20.mean)} | **${alpha == null ? '—' : fmtPct(alpha)}** |`);
    lines.push(`| top3 | ${t3.n} | ${fmtW(t3.win)} | | | ${fmtPct(t3.mean)} | | |`);
    lines.push(`| top5 | ${t5.n} | ${fmtW(t5.win)} | | | ${fmtPct(t5.mean)} | | |`);
    lines.push(`| cohort(全體基準) | ${coD5.n} | ${fmtW(coD5.win)} | | | ${fmtPct(coD5.mean)} | | — |`);
    lines.push('');
  }

  // ── 自動結論 ──
  lines.push('## 自動結論（排序到底有沒有 edge）');
  lines.push('');
  const verdicts: string[] = [];
  for (const key of ['chg', 'six', 'attack'] as RankKey[]) {
    const top1 = mk();
    for (const d of dates) {
      const cands = [...byDate.get(d)!].sort((a, b) => rankValue(b, key) - rankValue(a, key));
      cands.slice(0, 1).forEach((e) => push(top1, e));
    }
    const t1 = stat(top1.d5);
    const alpha = t1.mean != null && coD5.mean != null ? t1.mean - coD5.mean : null;
    const tag = alpha == null ? '樣本不足' : alpha > 0.3 ? '✅ 有 edge' : alpha > 0 ? '➖ 微弱' : '❌ 無/反向';
    verdicts.push(`- 依「${RANK_LABEL[key]}」取 top1：d5 ${fmtPct(t1.mean)}，排序alpha ${alpha == null ? '—' : fmtPct(alpha)} → ${tag}`);
  }
  lines.push(...verdicts);
  lines.push('');
  lines.push(`> cohort（三色訊號全體）d5 基準 = ${fmtPct(coD5.mean)}（勝率 ${fmtW(coD5.win)}，n=${coD5.n}）`);
  lines.push('> 排序alpha > 0 = 排序有把贏家排前面；這才是 daily-pick「取最前面 1-2 檔」可能賺錢的地方。');

  const md = lines.join('\n');
  const outPath = path.join(outDir, `rank-edge-backtest-${stamp}.md`);
  await fs.writeFile(outPath, md + '\n');
  console.log('\n' + md);
  console.log(`\n📄 已寫入 ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
