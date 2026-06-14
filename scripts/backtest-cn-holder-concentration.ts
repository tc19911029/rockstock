/**
 * 回測陸股「股东户数（籌碼集中度）」有沒有 edge — 誠實 edge + train/test 一致才算數。
 *
 * 問題：戶數變少（HOLDER_NUM_RATIO 為負）＝籌碼集中＝大戶在收 → 是不是該買？
 *       戶數變多（為正）＝籌碼分散 → 是不是該避開？還是兩邊都沒用？
 *
 * 方法（照 scripts/factor-grid-search.ts 紀律 + 誠實 edge）：
 *   - 事件 = 每筆季報股东户数公告。**進場用「公告日 noticeDate」次一交易日開盤**（不前視）。
 *   - 同股同公告日去重：一次揭多期 → 只留最新一期（=公告當下最新的集中度資訊）。
 *   - 訊號 = holderNumRatio，全體切五等分（Q0 最集中 → Q4 最分散）。
 *   - 報酬 = computeEventReturns 對上證 000001.SS 的超額（d20 / d60 / 持有至今），扣 CN 來回成本 0.112%。
 *   - train/test 用公告日中點切一半；同一組桶門檻，看兩半同方向才可信。
 *
 * 重用單一事實：settleBaseline / computeEventReturns（lib/backtest）、loadCandlesForEvent /
 *   loadShIndexCandles（lib/cn-agents/backtest/recoPipeline）、classifyCnBoard（lib/cn-agents/cnBoard）。
 *
 * 用法：npx tsx scripts/backtest-cn-holder-concentration.ts [--horizon d20|d60]（預設兩個都印）
 * 輸出：console 表 + data/backtest/cn-holder-concentration.json
 */
import { promises as fs } from 'fs';
import path from 'path';
import { classifyCnBoard } from '@/lib/cn-agents/cnBoard';
import { loadCandlesForEvent, loadShIndexCandles } from '@/lib/cn-agents/backtest/recoPipeline';
import { settleBaseline } from '@/lib/backtest/eventBaseline';
import { computeEventReturns, type RecoHorizon } from '@/lib/backtest/eventReturns';
import type { ShareholderCountQuarter } from '@/lib/datasource/EastMoneyShareholderCount';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

const DIR = path.join(process.cwd(), 'data', 'chips', 'CN', 'shareholder');
const OUT = path.join(process.cwd(), 'data', 'backtest', 'cn-holder-concentration.json');
const COST = 0.112; // 陸股來回成本 %（同 compute-honest-edge）

interface Ev {
  date: string;      // 進場交易日（公告日次一交易日）
  code: string;
  ratio: number;     // holderNumRatio：負=集中、正=分散
  d20: number | null;
  d60: number | null;
  hold: number | null; // 持有至今超額
}

interface ShareholderFile { code: string; symbol: string; quarters: ShareholderCountQuarter[]; }

const argv = process.argv.slice(2);
const horizonArg = (() => { const i = argv.indexOf('--horizon'); return i >= 0 ? argv[i + 1] : null; })();
// 剔除極端戶數變化（減資/合股/拆分造成的假訊號，如 +60,000,000%）；預設 80%
const clipArg = (() => { const i = argv.indexOf('--clip'); return i >= 0 ? parseFloat(argv[i + 1]) : 80; })();

const symbolOf = (code: string): string => {
  const b = classifyCnBoard(code);
  return `${code}.${b === 'SH-main' || b === 'STAR' ? 'SS' : 'SZ'}`;
};

/** 同 code 同 noticeDate 只留最新一期（max endDate）；回傳 [{noticeDate, ratio}]。 */
function dedupeByNotice(quarters: ShareholderCountQuarter[]): Array<{ notice: string; ratio: number }> {
  const best = new Map<string, ShareholderCountQuarter>();
  for (const q of quarters) {
    if (q.noticeDate == null || q.holderNumRatio == null) continue;
    const cur = best.get(q.noticeDate);
    if (!cur || q.endDate > cur.endDate) best.set(q.noticeDate, q);
  }
  return [...best.values()].map((q) => ({ notice: q.noticeDate as string, ratio: q.holderNumRatio as number }));
}

interface Bucket {
  label: string;
  ratioRange: [number, number];
  nAll: number; exAll: number | null; winAll: number | null; netAll: number | null;
  nTrain: number; exTrain: number | null;
  nTest: number; exTest: number | null;
}

function avg(xs: number[]): number | null { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function winPct(xs: number[]): number | null { return xs.length ? (100 * xs.filter((x) => x > 0).length) / xs.length : null; }
const f2 = (x: number | null): string => (x == null ? '  —  ' : (x >= 0 ? '+' : '') + x.toFixed(2));

/** 把事件依 ratio 切五等分（全體門檻），各桶算 all/train/test 超額。 */
function quintiles(events: Ev[], h: 'd20' | 'd60'): Bucket[] {
  const rows = events
    .filter((e) => e[h] != null)
    .map((e) => ({ date: e.date, ratio: e.ratio, ex: e[h] as number }))
    .sort((a, b) => a.ratio - b.ratio); // ratio 升冪：最集中(最負)在前
  if (rows.length === 0) return [];

  const mid = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1))[Math.floor(rows.length / 2)].date;
  const N = rows.length;
  const labels = ['Q0 最集中(戶數↓最多)', 'Q1', 'Q2 中間', 'Q3', 'Q4 最分散(戶數↑最多)'];
  const out: Bucket[] = [];
  for (let b = 0; b < 5; b++) {
    const lo = Math.floor((b * N) / 5);
    const hi = Math.floor(((b + 1) * N) / 5);
    const slice = rows.slice(lo, hi);
    const exAll = slice.map((r) => r.ex);
    const tr = slice.filter((r) => r.date < mid).map((r) => r.ex);
    const te = slice.filter((r) => r.date >= mid).map((r) => r.ex);
    const m = avg(exAll);
    out.push({
      label: labels[b],
      ratioRange: [slice[0].ratio, slice[slice.length - 1].ratio],
      nAll: slice.length, exAll: m, winAll: winPct(exAll), netAll: m == null ? null : +(m - COST).toFixed(2),
      nTrain: tr.length, exTrain: avg(tr),
      nTest: te.length, exTest: avg(te),
    });
  }
  return out;
}

type Grade = 'keep' | 'thin' | 'info' | 'avoid';
function grade(net: number | null, n: number, consistent: boolean): Grade {
  if (net == null) return 'avoid';
  if (net >= 0.5 && consistent && n >= 100) return 'keep';
  if (net >= 0) return 'thin';
  if (net >= -0.5) return 'info';
  return 'avoid';
}
const GRADE_TXT: Record<Grade, string> = {
  keep: '🟢 keep（扣成本仍贏大盤，值得做成訊號）',
  thin: '🟡 thin（幾乎打平大盤）',
  info: '⚪ info（輸大盤一點，當資訊別當買訊）',
  avoid: '🔴 avoid（顯著輸大盤）',
};

function printTable(buckets: Bucket[], caption: string) {
  console.log(`\n── ${caption} ──`);
  console.log('桶                          ratio區間          筆數    全期超額/勝率     train→test 一致');
  for (const b of buckets) {
    const consistent = b.exTrain != null && b.exTest != null &&
      ((b.exTrain > 0 && b.exTest > 0) || (b.exTrain < 0 && b.exTest < 0));
    const tag = b.exTrain == null || b.exTest == null ? '樣本不足'
      : consistent ? (b.exTest > 0 ? '✓同正' : '✓同負') : '✗反向';
    console.log(
      `${b.label.padEnd(24)} [${b.ratioRange[0].toFixed(1)}, ${b.ratioRange[1].toFixed(1)}]`.padEnd(48) +
      `${String(b.nAll).padStart(5)}   ${f2(b.exAll)}% / ${b.winAll == null ? '—' : b.winAll.toFixed(0)}%   ` +
      `${f2(b.exTrain)}→${f2(b.exTest)} ${tag}`,
    );
  }
}

async function main() {
  const files = (await fs.readdir(DIR)).filter((f) => /^\d{6}\.json$/.test(f));
  console.log(`讀 ${files.length} 檔股东户数…`);
  const index = await loadShIndexCandles();
  if (!index) { console.error('缺上證指數 K 線 000001.SS'); process.exit(1); }
  const now = new Date().toISOString();
  const todayYmd8 = now.slice(0, 10).replaceAll('-', '');

  const events: Ev[] = [];
  const cnt = { stocks: 0, attempts: 0, filled: 0, noFill: 0, noData: 0, pending: 0, noKline: 0, clipped: 0 };

  for (const f of files) {
    let rec: ShareholderFile;
    try { rec = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf-8')); } catch { continue; }
    if (!rec.quarters?.length) continue;
    cnt.stocks++;
    const code = rec.code;
    const symbol = rec.symbol || symbolOf(code);
    const candles = await loadCandlesForEvent(symbol, classifyCnBoard(code), todayYmd8);
    if (!candles) { cnt.noKline++; continue; }

    for (const { notice, ratio } of dedupeByNotice(rec.quarters)) {
      if (Math.abs(ratio) > clipArg) { cnt.clipped++; continue; } // 剔極端（減資/合股假訊號）
      cnt.attempts++;
      const baseline = settleBaseline(notice, candles, now);
      if (baseline.status === 'no_fill') { cnt.noFill++; continue; }
      if (baseline.status === 'no_data') { cnt.noData++; continue; }
      if (baseline.status === 'pending') { cnt.pending++; continue; }
      cnt.filled++;
      const r = computeEventReturns({ baseline }, candles, index);
      if (!r) continue;
      events.push({ date: baseline.base_date as string, code, ratio, d20: r.excess.d20, d60: r.excess.d60, hold: r.holdExcess });
    }
  }

  console.log(`\n事件：嘗試 ${cnt.attempts}、進場成功 ${cnt.filled}（一字板買不到 ${cnt.noFill}、無資料 ${cnt.noData}、待結算 ${cnt.pending}）；無 K 線檔 ${cnt.noKline}、剔極端戶數變化(>±${clipArg}%) ${cnt.clipped}`);
  console.log(`可回測事件 ${events.length}（覆蓋 ${cnt.stocks} 檔），對上證 000001.SS 超額`);

  const horizons: Array<'d20' | 'd60'> = horizonArg === 'd20' ? ['d20'] : horizonArg === 'd60' ? ['d60'] : ['d20', 'd60'];

  // (A) 對指數超額 — 含 universe beta（主板中小型 vs 上證大型股），會虛胖、僅供對照
  console.log('\n【A. 對上證超額（含 beta，虛胖僅對照）】公告日次一開盤進場、扣成本前');
  const rawTables: Record<string, Bucket[]> = {};
  for (const h of horizons) { const b = quintiles(events, h); rawTables[h] = b; printTable(b, `${h}（vs 指數）`); }

  // (B) 同月去平均的橫斷面 alpha — 同月全部事件減當月平均 → 同時洗掉 universe beta + 季報擠堆共同因子
  const monthKey = (d: string) => d.slice(0, 7);
  const monthMean = (h: 'd20' | 'd60') => {
    const acc = new Map<string, { s: number; n: number }>();
    for (const e of events) { const v = e[h]; if (v == null) continue; const k = monthKey(e.date); const o = acc.get(k) ?? { s: 0, n: 0 }; o.s += v; o.n++; acc.set(k, o); }
    const m = new Map<string, number>(); for (const [k, o] of acc) m.set(k, o.s / o.n); return m;
  };
  const m20 = monthMean('d20'), m60 = monthMean('d60');
  const demeaned: Ev[] = events.map((e) => ({
    ...e,
    d20: e.d20 == null ? null : +(e.d20 - (m20.get(monthKey(e.date)) as number)).toFixed(2),
    d60: e.d60 == null ? null : +(e.d60 - (m60.get(monthKey(e.date)) as number)).toFixed(2),
  }));
  console.log('\n【B. 同月去平均的橫斷面 alpha（誠實：beta + 擠堆已洗掉）】數字＝該桶比「當月同類股平均」好多少');
  const tables: Record<string, Bucket[]> = {};
  for (const h of horizons) { const b = quintiles(demeaned, h); tables[h] = b; printTable(b, `${h}（同月去平均·誠實）`); }

  // ── 結論：以誠實版(B)為準。買訊看 Q0（最集中），避雷看 Q4（最分散），d60 為主 ──
  const verdictH: 'd20' | 'd60' = horizons.includes('d60') ? 'd60' : 'd20';
  const vb = tables[verdictH];
  const q0 = vb[0], q1 = vb[1], q4 = vb[4];
  const q0Consistent = q0.exTrain != null && q0.exTest != null && q0.exTrain > 0 && q0.exTest > 0;
  const q4Consistent = q4.exTrain != null && q4.exTest != null && q4.exTrain < 0 && q4.exTest < 0;
  const buyGrade = grade(q0.netAll, q0.nAll, q0Consistent);
  // 集中溢價改用「含 beta 對照版」的 Q0−Q4（兩桶同吃 beta，相減才乾淨；誠實版已去平均故另列）
  const rawVb = rawTables[verdictH];
  const spread = rawVb[0].exAll != null && rawVb[4].exAll != null ? +(rawVb[0].exAll - rawVb[4].exAll).toFixed(2) : null;

  console.log(`\n========== 結論（誠實版·以 ${verdictH} 為準）==========`);
  console.log(`最集中 vs 最分散 超額差（集中溢價，beta 相減後）：${spread == null ? '—' : (spread >= 0 ? '+' : '') + spread + '%'}`);
  console.log(`最集中兩桶 vs 當月同類平均：Q0 ${f2(q0.exAll)}%、Q1 ${f2(q1.exAll)}%（勝同類 ${q0.winAll == null ? '—' : q0.winAll.toFixed(0)}% / ${q1.winAll == null ? '—' : q1.winAll.toFixed(0)}%）`);
  console.log(`當買訊（最集中 Q0，扣成本淨 ${f2(q0.netAll)}%、train/test ${q0Consistent ? '同正一致' : '不一致或樣本不足'}）：${GRADE_TXT[buyGrade]}`);
  console.log(`當避雷（最分散 Q4 vs 同類 ${f2(q4.exAll)}%）：${q4Consistent ? '🔴 兩半都負＝可信避雷' : '— 兩半未同負，避雷不成立'}`);

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await atomicFsPut(OUT, JSON.stringify({
    generatedAt: now,
    method: '股东户数 holderNumRatio 五等分；公告日次一開盤進場；誠實版=同月去平均的橫斷面 alpha（洗掉 universe beta + 季報擠堆）；扣 CN 來回成本 0.112%',
    costRoundTripPct: COST,
    counts: cnt,
    nEvents: events.length,
    verdictHorizon: verdictH,
    concentrationPremiumVsIndex: spread,
    buy: { bucket: 'Q0', demeanedAlpha: q0.exAll, netAll: q0.netAll, winVsPeers: q0.winAll, consistent: q0Consistent, grade: buyGrade },
    avoid: { bucket: 'Q4', demeanedAlpha: q4.exAll, reliable: q4Consistent },
    tablesHonest: tables,
    tablesVsIndex: rawTables,
  }, null, 1));
  console.log(`\n已寫 ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
