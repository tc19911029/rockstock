// ============================================================
// 大戶偷買（W）∩ 法人接刀（X）—— 「交集」實證回測（研究腳本，TW only）
//
// 問題：一檔股票同時滿足「大戶偷買」與「法人接刀」，是否更容易買到會漲的？
//
// 背景（已查 code + 記憶）：
//   - 大戶偷買（lib/smartmoney，主力分點集中度由負轉正）：單獨回測沒有穩定 edge，
//     贏大盤 <50%、去 beta 後超額 ≈ 0 → 只當顯示/紀律參考，不進選股（[[smartmoney_dip_strategy]]）。
//   - 法人接刀（lib/instdip，跌/長黑 + 法人逆勢買 + 剔除大戶持股超高）：factor-grid-search 裡
//     唯一 train+test 兩年都正的買法，但只是微微傾斜、贏大盤仍 <50%、靠賠少賺多。
//   - 兩者「交集」從沒被測過。把零料條件疊到微料條件上，預期不加分、且交集縮樣本 →
//     容易冒出小樣本假象（smartmoney 7 月 +7.9%/83%、n=54 那種）。必須用數據講話。
//
// 方法（複用既有單一事實，鐵則 #5/#10：不自刻訊號、不自刻前向報酬）：
//   - 訊號：lib/smartmoney/signal.evaluateAt（W）、lib/instdip/signal.evaluateAt（X），各回 isHit。
//   - 大戶持股剔除：lib/avoidance/chipAvoidSignals 的凍結門檻（文件＝各級距 90 百分位，
//     ≈ X 軌「當日候選砍持股最高 10%」的可重現等價）。套在 INST / BOTH。
//   - 進場 + 前向報酬：lib/backtest/eventBaseline.settleBaseline（隔日開盤、一字板 no_fill、
//     污染守衛）+ lib/backtest/eventReturns.computeEventReturns（d5/d10/d20 對 ^TWII 逐事件超額）。
//   - 只在「兩訊號都可評估」的 K 棒納入（同一批 bar → 四格公平對照）。
//   - 切 train / test（依進場日中位數），每格分別報超額/勝率/樣本，看 BOTH 是否兩段都勝過 INST。
//
// ⚠️ 純研究：不改 production 掃描、不接選股鏈路、不碰陸股（無對應歷史資料）。
//   宇宙＝有「主力分點 ∩ 法人」資料的股票（法人資料僅 ~390 檔）→ 存活/覆蓋偏差，結論偏樂觀。
//
// 用法：npx tsx scripts/backtest-smartmoney-instdip-intersection.ts [limit=0]
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { readBrokerStock } from '@/lib/chips/BrokerStorage';
import { evaluateAt as evalSmart } from '@/lib/smartmoney/signal';
import { DEFAULT_PARAMS as SMART_PARAMS } from '@/lib/smartmoney/types';
import { evaluateAt as evalInst } from '@/lib/instdip/signal';
import { DEFAULT_PARAMS as INST_PARAMS } from '@/lib/instdip/types';
import { CHIP_AVOID_PARAMS } from '@/lib/avoidance/chipAvoidSignals';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { computeEventReturns } from '@/lib/backtest/eventReturns';
import type { Candle } from '@/types';

const TW_INDEX = '^TWII';
const COST_TW = 0.585; // 來回成本%（手續費 0.1425×2 + 證交稅 0.3）
const MIN_FWD_BARS = 20; // d20 要走完
const MIN_BARS = 60;     // 至少夠 smartmoney(25) + 緩衝

// ── cell 定義 ───────────────────────────────────────────────────
const CELL_ORDER = ['ALL', 'INST', 'SMART', 'BOTH', 'BOTH_raw'] as const;
type CellId = typeof CELL_ORDER[number];
const CELL_LABELS: Record<CellId, string> = {
  ALL: '全宇宙可進場K棒（基準，去 beta 後應接近 0）',
  INST: '只法人接刀（X 軌：含剔除大戶持股超高）',
  SMART: '只大戶偷買（W 軌：純訊號）',
  BOTH: '交集：大戶偷買 ∩ 法人接刀（含剔除大戶持股超高）',
  BOTH_raw: '交集（不剔除大戶持股，純兩訊號）',
};

// ── 載入 helpers ─────────────────────────────────────────────────
async function readCandles(dir: string, symbol: string): Promise<Candle[] | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${symbol}.json`), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.candles)) return null;
    const cs = data.candles as Candle[];
    for (const c of cs) if (typeof c.date === 'string' && c.date.endsWith('*')) c.date = c.date.slice(0, -1);
    return cs;
  } catch { return null; }
}

interface TdccRow { date: string; holder100Pct?: number; holder400Pct?: number; holder1000Pct?: number }
async function readTdcc(code: string): Promise<TdccRow[]> {
  try {
    const tj = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'chips', 'TW', 'tdcc', `${code}.json`), 'utf8'));
    return (tj.data || []) as TdccRow[]; // 升冪
  } catch { return []; }
}

async function readInstMap(code: string): Promise<Map<string, number> | null> {
  try {
    const inst = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'chips', 'TW', 'inst', `${code}.json`), 'utf8'));
    return new Map<string, number>((inst.data || []).map((d: { date: string; total?: number }): [string, number] => [d.date, d.total ?? 0]));
  } catch { return null; }
}

/** 大戶持股「超高」判定（依股價挑級距，凍結絕對門檻 = 各級距 90 百分位） */
function holderTooHigh(tdcc: TdccRow[], onDate: string, price: number): boolean {
  // 找最新一列 date <= onDate
  let row: TdccRow | undefined;
  for (let i = tdcc.length - 1; i >= 0; i--) { if (tdcc[i].date <= onDate) { row = tdcc[i]; break; } }
  if (!row) return false;
  const H = CHIP_AVOID_PARAMS.holderHighPct;
  const t = price >= 250 ? { v: row.holder100Pct, th: H.h100 }
    : price >= 50 ? { v: row.holder400Pct, th: H.h400 }
      : { v: row.holder1000Pct, th: H.h1000 };
  return t.v != null && t.v > t.th;
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

// ── event 累積 ───────────────────────────────────────────────────
interface Ev {
  entryDate: string;
  exD5: number | null; exD10: number | null; exD20: number | null; // 對 ^TWII 超額
  rawD5: number | null; rawD20: number | null;                     // 原始報酬
  mfe: number | null; mae: number | null;
  smart: boolean; inst: boolean; both: boolean; bothRaw: boolean;
}

function aggCell(events: Ev[], pred: (e: Ev) => boolean) {
  const xs = events.filter(pred);
  const exD5 = stat(xs.map((e) => e.exD5!).filter((x) => x != null));
  const exD10 = stat(xs.map((e) => e.exD10!).filter((x) => x != null));
  const exD20 = stat(xs.map((e) => e.exD20!).filter((x) => x != null));
  const rawD5 = stat(xs.map((e) => e.rawD5!).filter((x) => x != null));
  const rawD20 = stat(xs.map((e) => e.rawD20!).filter((x) => x != null));
  const mfe = stat(xs.map((e) => e.mfe!).filter((x) => x != null));
  const mae = stat(xs.map((e) => e.mae!).filter((x) => x != null));
  return { n: xs.length, exD5, exD10, exD20, rawD5, rawD20, mfe, mae };
}
type CellStat = ReturnType<typeof aggCell>;
const CELL_PRED: Record<CellId, (e: Ev) => boolean> = {
  ALL: () => true,
  INST: (e) => e.inst,
  SMART: (e) => e.smart,
  BOTH: (e) => e.both,
  BOTH_raw: (e) => e.bothRaw,
};

async function main() {
  const limit = parseInt(process.argv[2] ?? '0', 10) || 0;
  const stamp = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const dir = getLocalCandleDir('TW');
  const outDir = path.join(process.cwd(), 'data', 'backtest-output');
  await fs.mkdir(outDir, { recursive: true });

  // 指數（^TWII）一次載入
  const idxCandles = (await readCandles(dir, TW_INDEX)) as BaselineCandle[] | null;
  if (!idxCandles || !idxCandles.length) throw new Error(`找不到指數本地K線（${TW_INDEX}）`);

  // 宇宙 = 有「主力分點 ∩ 法人」資料的四碼普通股
  const brokerFiles = new Set((await fs.readdir(path.join(process.cwd(), 'data/chips/TW/broker'))).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
  const instFiles = (await fs.readdir(path.join(process.cwd(), 'data/chips/TW/inst'))).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  let universe = instFiles.filter((c) => brokerFiles.has(c) && /^\d{4}$/.test(c) && !c.startsWith('00'));
  universe.sort();
  if (limit > 0) universe = universe.slice(0, limit);
  console.log(`[W∩X] TW universe ${universe.length} 檔（broker ∩ inst 四碼普通股）｜訊號=smartmoney(W)+instdip(X) 單一事實｜進場=隔日開盤`);

  const events: Ev[] = [];
  let stocksUsed = 0, stocksSkipped = 0, evalBars = 0, noFill = 0, noData = 0, smartHits = 0, instHits = 0, bothHits = 0;
  const t0 = Date.now();

  const BATCH = 40;
  for (let b = 0; b < universe.length; b += BATCH) {
    const batch = universe.slice(b, b + BATCH);
    const loaded = await Promise.all(batch.map(async (code) => {
      const [candles, brokerFile, instMap, tdcc] = await Promise.all([
        readCandles(dir, `${code}.TW`),
        readBrokerStock(code),
        readInstMap(code),
        readTdcc(code),
      ]);
      return { code, candles, brokerFile, instMap, tdcc };
    }));

    for (const { code, candles, brokerFile, instMap, tdcc } of loaded) {
      if (!candles || candles.length < MIN_BARS || !brokerFile || !instMap) { stocksSkipped++; continue; }
      const brokerMap = new Map<string, number>(brokerFile.data.map((r) => [r.date, r.netDifference]));
      const bc = candles as BaselineCandle[];
      let used = false;
      const hi = candles.length - 1 - MIN_FWD_BARS; // 要 d20 走完
      for (let t = 25; t <= hi; t++) {
        // 兩訊號都要可評估，才納入（同一批 bar → 公平）
        const sEv = evalSmart(candles as { date: string; close: number; volume: number }[], brokerMap, t, SMART_PARAMS);
        if (!sEv) continue;
        const iEv = evalInst(candles as { date: string; open: number; close: number; volume: number }[], instMap, t, INST_PARAMS);
        if (!iEv) continue;
        evalBars++;

        // 進場 + 前向報酬（單一事實）
        const baseline = settleBaseline(candles[t].date, bc, now);
        if (baseline.status === 'no_fill') { noFill++; continue; }
        if (baseline.status !== 'filled') { noData++; continue; }
        const r = computeEventReturns({ baseline }, bc, idxCandles);
        if (!r) { noData++; continue; }

        const tooHigh = holderTooHigh(tdcc, candles[t].date, candles[t].close);
        const smart = sEv.isHit;
        const instRaw = iEv.isHit;
        const inst = instRaw && !tooHigh;          // X 軌：含剔除
        const both = smart && inst;
        const bothRaw = smart && instRaw;          // 純兩訊號交集

        if (smart) smartHits++;
        if (inst) instHits++;
        if (both) bothHits++;

        events.push({
          entryDate: baseline.base_date!,
          exD5: r.excess.d5, exD10: r.excess.d10, exD20: r.excess.d20,
          rawD5: r.d5, rawD20: r.d20, mfe: r.mfe, mae: r.mae,
          smart, inst, both, bothRaw,
        });
        used = true;
      }
      if (used) stocksUsed++; else stocksSkipped++;
    }
    if ((b / BATCH) % 5 === 0) {
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`[W∩X] 進度 ${Math.min(b + BATCH, universe.length)}/${universe.length}｜用 ${stocksUsed} 檔｜可評估 bar ${evalBars}｜BOTH 命中 ${bothHits}｜${el}s`);
    }
  }

  // train / test 依進場日中位數切兩半
  const dates = [...new Set(events.map((e) => e.entryDate))].sort();
  const cut = dates.length ? dates[Math.floor(dates.length / 2)] : '9999';
  const trainEv = events.filter((e) => e.entryDate < cut);
  const testEv = events.filter((e) => e.entryDate >= cut);
  console.log(`[W∩X] 完成：用 ${stocksUsed} 檔 / 跳過 ${stocksSkipped}｜可評估 ${evalBars}｜no_fill ${noFill}｜no_data ${noData}`);
  console.log(`[W∩X] 命中：大戶偷買 ${smartHits}｜法人接刀(含剔除) ${instHits}｜交集 ${bothHits}｜進場日 ${dates[0]} ~ ${dates[dates.length - 1]}｜切點 ${cut}`);

  // ── 報告 ──
  const segs: Array<{ name: string; ev: Ev[] }> = [
    { name: '全期', ev: events },
    { name: `train（${dates[0]} ~ <${cut}）`, ev: trainEv },
    { name: `test（${cut} ~ ${dates[dates.length - 1]}）`, ev: testEv },
  ];

  const lines: string[] = [];
  lines.push(`# 大戶偷買（W）∩ 法人接刀（X）— 交集回測（TW，${stamp}）`);
  lines.push('');
  lines.push(`宇宙 ${universe.length} 檔（broker ∩ inst 四碼普通股，法人資料僅 ~390 檔 → 覆蓋/存活偏差，結論偏樂觀）`);
  lines.push(`可評估 bar ${evalBars}｜進場：隔日開盤（settleBaseline，一字板 no_fill ${noFill} 剔除）｜超額對 ^TWII（computeEventReturns 逐事件、日曆日對齊）`);
  lines.push(`訊號＝lib/smartmoney + lib/instdip 單一事實 evaluateAt；大戶持股剔除＝chipAvoidSignals 凍結門檻（≈ 90 百分位）`);
  lines.push(`判讀：看「超額」（已扣大盤 beta）。交集要算「更準」必須 BOTH 的超額 > INST，且 train/test 兩段都成立、樣本夠（≥60）。`);
  lines.push('');

  for (const seg of segs) {
    const cells = CELL_ORDER.map((id) => ({ id, label: CELL_LABELS[id], s: aggCell(seg.ev, CELL_PRED[id]) }));
    lines.push(`## ${seg.name}`);
    lines.push('');
    lines.push('| cell | n | 超額d5 | 超額d10 | 超額d20 | 勝率d20(贏大盤) | 原始d20 | 平均最高 | 平均最低 |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const c of cells) {
      const s = c.s;
      lines.push(`| ${c.label} | ${s.n} | ${fmtPct(s.exD5.mean)} | ${fmtPct(s.exD10.mean)} | ${fmtPct(s.exD20.mean)} | ${fmtW(s.exD20.win)} | ${fmtPct(s.rawD20.mean)} | ${fmtPct(s.mfe.mean)} | ${fmtPct(s.mae.mean)} |`);
    }
    lines.push('');
  }

  // ── 自動結論 ──
  const aggBy = (ev: Ev[]) => ({
    INST: aggCell(ev, CELL_PRED.INST),
    BOTH: aggCell(ev, CELL_PRED.BOTH),
  });
  const tr = aggBy(trainEv), te = aggBy(testEv), all = aggBy(events);
  const netExcess = (c: CellStat, h: 'exD5' | 'exD20') => (c[h].mean == null ? null : c[h].mean - COST_TW);
  const betterBoth = (h: 'exD5' | 'exD20') => {
    const tB = tr.BOTH[h].mean, tI = tr.INST[h].mean, eB = te.BOTH[h].mean, eI = te.INST[h].mean;
    if (tB == null || tI == null || eB == null || eI == null) return null;
    return tB > tI && eB > eI;
  };

  lines.push('## 自動結論');
  lines.push('');
  lines.push(`- 全期：法人接刀超額 d20 ${fmtPct(all.INST.exD20.mean)}（n=${all.INST.n}）｜交集超額 d20 ${fmtPct(all.BOTH.exD20.mean)}（n=${all.BOTH.n}）`);
  lines.push(`- 扣成本後淨超額 d20：法人接刀 ${fmtPct(netExcess(all.INST, 'exD20'))}｜交集 ${fmtPct(netExcess(all.BOTH, 'exD20'))}`);
  const b20 = betterBoth('exD20'), b5 = betterBoth('exD5');
  lines.push(`- 交集 d20 超額是否「train 和 test 兩段都贏過只看法人接刀」：**${b20 == null ? '樣本不足、無法判定' : b20 ? '是 ✅' : '否 ❌'}**`);
  lines.push(`- 交集 d5 超額同上：**${b5 == null ? '樣本不足、無法判定' : b5 ? '是 ✅' : '否 ❌'}**`);
  const bothEnough = (te.BOTH.n >= 60 && tr.BOTH.n >= 60);
  lines.push(`- 交集樣本是否夠（train/test 各 ≥60）：**${bothEnough ? '夠' : `不夠（train ${tr.BOTH.n} / test ${te.BOTH.n}）→ 小樣本，任何「變好」都可能是假象`}**`);
  const verdict = (b20 && bothEnough && (netExcess(all.BOTH, 'exD20') ?? -9) > (netExcess(all.INST, 'exD20') ?? -9))
    ? '🟢 交集「可能」更準 — 但仍需另跑 compute-honest-edge 對齊主視圖才可上線'
    : '🔴 交集沒有更準（或樣本太少不可信）→ 不接進選股，維持現狀';
  lines.push('');
  lines.push(`### ${verdict}`);
  lines.push('');

  const outPath = path.join(outDir, `smartmoney-instdip-intersection-TW-${stamp}.md`);
  await fs.writeFile(outPath, lines.join('\n'), 'utf8');
  const jsonPath = path.join(outDir, `smartmoney-instdip-intersection-TW-${stamp}.json`);
  await fs.writeFile(jsonPath, JSON.stringify({
    stamp, universe: universe.length, evalBars, noFill, noData,
    smartHits, instHits, bothHits, cut, dateMin: dates[0], dateMax: dates[dates.length - 1],
    segments: segs.map((seg) => ({ name: seg.name, cells: CELL_ORDER.map((id) => ({ id, ...aggCell(seg.ev, CELL_PRED[id]) })) })),
  }, null, 1), 'utf8');
  console.log(`[W∩X] 報告 → ${outPath}`);
  console.log(lines.slice(lines.indexOf('## 自動結論')).join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
