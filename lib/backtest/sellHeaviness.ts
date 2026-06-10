// ============================================================
// 賣出訊號「輕重」回測 — 純核心（無 IO）
//
//   - inHoldableContext / isVolSuspect：firing 當下的情境判定（皆只讀 ≤i 的資料，因果安全）
//   - CohortAccumulator：逐 (日期×情境) 累積同儕宇宙的 forward 報酬均值（regime 基準）
//   - CoOccurrenceAccumulator：逐根累積同根共現，finalize 成 P(B|A)（多重共線性揭露）
//   - aggregateSignal / buildSignalStats：把 firing 收成 SignalStat（alpha 差分 + shrink + tStat + 半窗穩定）
//   - severityVerdict / heavinessScore：手寫嚴重度對照 + 次要複合分（權重透明）
//   - buildSellHeavinessMarkdown：人類可讀報告（仿 unifiedLeaderboard.ts:buildMarkdown）
//
// 統計刻意保守：alpha 一律「訊號 − 同日同儕」，prior=0 shrink 把小樣本拉回「無 edge」。
// ============================================================

import type { CandleWithIndicators } from '@/types';
import type {
  Market, SellScope, SellHorizon, SignalFamily, SignalStat, SellHorizonStat,
  SellSampleFiring, DeclaredSeverity, SeverityVerdict, SellHeavinessDoc,
} from './sellHeavinessTypes';
import { SELL_HORIZONS, SELL_SCOPES } from './sellHeavinessTypes';
import type { SellPickMetrics } from './sellForwardMetrics';

// ── Config（透明可改的單一旋鈕）─────────────────────────────────────────────
export const SELL_CFG = {
  /** 進排行的最低觸發數（每 訊號×市場×情境）。不足仍存但標 underpowered、不進 headline。 */
  MIN_FIRINGS: 50,
  /** Bayesian shrink K（prior=0 alpha；無樣本=無 edge）。同 rankingScore.ts 的 K=20。 */
  SHRINK_K: 20,
  /** 某日同儕宇宙樣本數須 ≥ 此值，該 firing 的 alpha 才計入（否則只計原始報酬）。 */
  COHORT_MIN_N: 5,
  /** 持股情境（in-uptrend）門檻。 */
  holdable: { upThr: 0.05, lookbackN: 20 },
  /** 次要複合分權重。 */
  weights: { w1: 1.0, w2: 0.5, w3: 0.3 },
  /** 實測輕重分級門檻（worst-of-{d5,d10,d20} 收斂 alpha，%）。
   *  依台/陸兩市場 2 年實測 alpha 分佈校準：最重訊號約 −1.0~−1.3，故 heavy ≤ −0.6。 */
  empiricalTier: { heavy: -0.6, medium: -0.2 },
} as const;

/** 量門控訊號（對「股 vs 張/手」單位跳階敏感，需 volSuspect 分版呈現）。 */
export const VOLUME_GATED_TYPES: ReadonlySet<string> = new Set([
  'HIGH_VOL_UPPER_SHADOW', 'HIGH_VOL_2DAY_3BLACK', 'PROFIT_CLIMAX_EXIT',
]);

/** 三色該賣事件（驅動手機 ntfy 的那批 + m_weak 研究事件）。 */
export const SANSE_SELL_DEFS: { id: string; label: string }[] = [
  { id: 'b_dead', label: '雙B死叉（黃跌破紅）' },
  { id: 'b_breakdn', label: '跌破智能交易線' },
  { id: 'b_sresonance', label: '雙重共振（死叉+跌破同日）' },
  { id: 'c_dead', label: '捕撈動能死叉' },
  { id: 'm_weak', label: '主力轉弱（中線<0，研究事件）' },
];

/** 衍生組合（同根多訊號）。predicate 吃「該根所有觸發的 atomic 訊號型別集合」+ high 數。 */
export const COMBO_DEFS: {
  id: string; label: string; pred: (fired: ReadonlySet<string>, highCount: number) => boolean;
}[] = [
  {
    id: 'combo:DEATH_CROSS+BREAK_MA20', label: '死叉＋跌破月線（趨勢真破）',
    pred: (f) => f.has('DEATH_CROSS') && f.has('BREAK_MA20'),
  },
  {
    id: 'combo:BREAK_MA10+KD_DEATH_CROSS', label: '跌破MA10＋KD高位死叉',
    pred: (f) => f.has('BREAK_MA10') && f.has('KD_DEATH_CROSS'),
  },
  {
    id: 'combo:HIGH_SEVERITY>=2', label: '同根 ≥2 個 high 訊號',
    pred: (_f, highCount) => highCount >= 2,
  },
];

// ── 情境判定 ─────────────────────────────────────────────────────────────────

/**
 * 持股情境：訊號當下仍在多頭、值得持有的股。
 *   close>ma20 且 ma5>ma20（對齊 sellSignals.ts 的 isHighLevel gate）且前 N 日漲 ≥ upThr。
 * 只讀 candles[≤i]，因果安全。
 */
export function inHoldableContext(
  candles: CandleWithIndicators[],
  i: number,
  cfg = SELL_CFG.holdable,
): boolean {
  const c = candles[i];
  if (!c) return false;
  const ma5 = c.ma5;
  const ma20 = c.ma20;
  if (ma5 == null || ma20 == null) return false;
  if (!(c.close > ma20) || !(ma5 > ma20)) return false;
  const j = i - cfg.lookbackN;
  if (j < 0) return false;
  const past = candles[j].close;
  if (!(past > 0)) return false;
  return (c.close / past - 1) >= cfg.upThr;
}

/**
 * 量單位污染偵測（已知 L1 問題）：firing 根的 volume 對 ±10 根 robust median 跳 >10×，
 * 且價沒對應大波動（|漲跌| < 9%）→ 疑似「股 vs 張/手」單位斷層的假爆量。
 */
export function isVolSuspect(candles: CandleWithIndicators[], i: number): boolean {
  const v = candles[i]?.volume;
  if (!(v > 0)) return false;
  const around: number[] = [];
  for (let k = i - 10; k <= i + 10; k++) {
    if (k === i || k < 0 || k >= candles.length) continue;
    const vv = candles[k].volume;
    if (vv > 0) around.push(vv);
  }
  if (around.length < 6) return false;
  around.sort((a, b) => a - b);
  const med = around[Math.floor(around.length / 2)];
  if (!(med > 0)) return false;
  if (v / med < 10) return false;
  const c = candles[i];
  const move = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  return move < 0.09;
}

// ── Firing 記錄（harness 產生、aggregation 消費）──────────────────────────────
export interface FiringRecord {
  signalType: string;
  label: string;
  family: SignalFamily;
  declaredSeverity: DeclaredSeverity;
  market: Market;
  date: string;
  symbol: string;
  name: string;
  base: number;
  inContext: boolean;
  volSuspect: boolean;
  suspect: boolean;      // 停牌缺口（已在 harness 過濾，這裡備查）
  m: SellPickMetrics;
}

// ── 同儕基準累積（per 日期×情境的 forward 均值）──────────────────────────────
interface CohortCell {
  sum: Record<SellHorizon, number>;
  cnt: Record<SellHorizon, number>;
  hit3Sum: number; hit5Sum: number; hitN: number;
}
function emptyCell(): CohortCell {
  const sum = {} as Record<SellHorizon, number>;
  const cnt = {} as Record<SellHorizon, number>;
  for (const h of SELL_HORIZONS) { sum[h] = 0; cnt[h] = 0; }
  return { sum, cnt, hit3Sum: 0, hit5Sum: 0, hitN: 0 };
}

export class CohortAccumulator {
  private cells = new Map<string, CohortCell>();
  private key(date: string, scope: SellScope): string { return `${date}|${scope}`; }

  add(date: string, scope: SellScope, m: SellPickMetrics): void {
    const k = this.key(date, scope);
    let cell = this.cells.get(k);
    if (!cell) { cell = emptyCell(); this.cells.set(k, cell); }
    for (const h of SELL_HORIZONS) {
      const v = m[h];
      if (v != null && Number.isFinite(v)) { cell.sum[h] += v; cell.cnt[h] += 1; }
    }
    if (m.hit3 != null) { cell.hit3Sum += m.hit3 ? 1 : 0; cell.hit5Sum += m.hit5 ? 1 : 0; cell.hitN += 1; }
  }

  mean(date: string, scope: SellScope, h: SellHorizon): number | null {
    const cell = this.cells.get(this.key(date, scope));
    if (!cell || cell.cnt[h] === 0) return null;
    return cell.sum[h] / cell.cnt[h];
  }
  count(date: string, scope: SellScope, h: SellHorizon = 'd5'): number {
    return this.cells.get(this.key(date, scope))?.cnt[h] ?? 0;
  }
  hit3Rate(date: string, scope: SellScope): number | null {
    const cell = this.cells.get(this.key(date, scope));
    if (!cell || cell.hitN === 0) return null;
    return (cell.hit3Sum / cell.hitN) * 100;
  }
  hit5Rate(date: string, scope: SellScope): number | null {
    const cell = this.cells.get(this.key(date, scope));
    if (!cell || cell.hitN === 0) return null;
    return (cell.hit5Sum / cell.hitN) * 100;
  }
}

// ── 共現累積（同根 atomic 訊號）→ P(B|A) ─────────────────────────────────────
export class CoOccurrenceAccumulator {
  private single = new Map<string, number>();
  private pair = new Map<string, Map<string, number>>();
  add(firedTypes: string[]): void {
    const uniq = Array.from(new Set(firedTypes));
    for (const a of uniq) {
      this.single.set(a, (this.single.get(a) ?? 0) + 1);
      let row = this.pair.get(a);
      if (!row) { row = new Map(); this.pair.set(a, row); }
      for (const b of uniq) if (b !== a) row.set(b, (row.get(b) ?? 0) + 1);
    }
  }
  finalize(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [a, na] of this.single) {
      const row: Record<string, number> = {};
      const pr = this.pair.get(a);
      if (pr && na > 0) for (const [b, nab] of pr) row[b] = +(nab / na).toFixed(3);
      out[a] = row;
    }
    return out;
  }
}

// ── 統計小工具 ───────────────────────────────────────────────────────────────
const round2 = (x: number): number => Math.round(x * 100) / 100;
function mean(v: number[]): number { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function std(v: number[]): number {
  if (v.length < 2) return 0;
  const mu = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / (v.length - 1));
}

// ── 單訊號聚合 ───────────────────────────────────────────────────────────────
/** firings 已為 (signalType, market, scope) 過濾後的子集；cohort 用同 scope。 */
export function aggregateSignal(
  signalType: string, label: string, family: SignalFamily, declaredSeverity: DeclaredSeverity,
  market: Market, scope: SellScope, firings: FiringRecord[], cohort: CohortAccumulator,
): SignalStat {
  const K = SELL_CFG.SHRINK_K;
  const byHorizon = {} as Record<SellHorizon, SellHorizonStat>;
  // d5 的逐筆 alpha（給 tStat / 半窗穩定用）
  const d5AlphaPairs: { date: string; alpha: number }[] = [];

  for (const h of SELL_HORIZONS) {
    const rets: number[] = [];
    const cohortVals: number[] = [];
    const alphas: number[] = [];
    let down = 0; let downN = 0;
    for (const f of firings) {
      const v = f.m[h];
      if (v == null || !Number.isFinite(v)) continue;
      rets.push(v);
      downN += 1; if (v < 0) down += 1;
      const cm = cohort.mean(f.date, scope, h);
      const cn = cohort.count(f.date, scope, h);
      if (cm != null && cn >= SELL_CFG.COHORT_MIN_N) {
        cohortVals.push(cm);
        const a = v - cm;
        alphas.push(a);
        if (h === 'd5') d5AlphaPairs.push({ date: f.date, alpha: a });
      }
    }
    const n = rets.length;
    const alphaMean = alphas.length ? mean(alphas) : 0;
    byHorizon[h] = {
      n,
      avgRetPct: round2(mean(rets)),
      medianRetPct: round2(median(rets)),
      cohortAvgPct: round2(mean(cohortVals)),
      alphaPct: round2(alphaMean),
      alphaShrunkPct: round2(alphas.length ? (alphas.length * alphaMean) / (alphas.length + K) : 0),
      downRatePct: downN ? round2((down / downN) * 100) : 0,
    };
  }

  // 窗內回落 / 跳空 / 跌幅命中 + 同儕超額
  const dds = firings.map((f) => f.m.maxDrawdown).filter((x): x is number => x != null);
  const mgs = firings.map((f) => f.m.maxGain).filter((x): x is number => x != null);
  const gaps = firings.map((f) => f.m.gapReturn).filter((x): x is number => x != null);
  const hit3vals: number[] = []; const hit3excess: number[] = [];
  const hit5vals: number[] = []; const hit5excess: number[] = [];
  for (const f of firings) {
    if (f.m.hit3 == null) continue;
    hit3vals.push(f.m.hit3 ? 1 : 0); hit5vals.push(f.m.hit5 ? 1 : 0);
    const c3 = cohort.hit3Rate(f.date, scope); const c5 = cohort.hit5Rate(f.date, scope);
    if (c3 != null) hit3excess.push((f.m.hit3 ? 100 : 0) - c3);
    if (c5 != null) hit5excess.push((f.m.hit5 ? 100 : 0) - c5);
  }

  // headline d5 + tStat + 半窗穩定
  const alphaD5 = byHorizon.d5.alphaPct;
  const alphaD5Shrunk = byHorizon.d5.alphaShrunkPct;
  const d5alphas = d5AlphaPairs.map((p) => p.alpha);
  const sd = std(d5alphas);
  const tStat = d5alphas.length > 1 && sd > 0 ? round2(mean(d5alphas) / (sd / Math.sqrt(d5alphas.length))) : 0;
  const sortedByDate = [...d5AlphaPairs].sort((a, b) => a.date.localeCompare(b.date));
  const mid = Math.floor(sortedByDate.length / 2);
  const early = sortedByDate.slice(0, mid).map((p) => p.alpha);
  const late = sortedByDate.slice(mid).map((p) => p.alpha);
  const aEarly = round2(mean(early)); const aLate = round2(mean(late));
  const sameSign = (aEarly <= 0) === (aLate <= 0);
  const ratioOK = Math.max(Math.abs(aEarly), Math.abs(aLate)) <= 2 * Math.min(Math.abs(aEarly), Math.abs(aLate)) + 1e-9;
  const stable = early.length > 0 && late.length > 0 && sameSign && ratioOK;

  const avgMaxDrawdownPct = round2(mean(dds));
  const downHit3ExcessPct = round2(mean(hit3excess));
  const heavinessScore = round2(
    SELL_CFG.weights.w1 * (-alphaD5Shrunk) +
    SELL_CFG.weights.w2 * (downHit3ExcessPct / 10) +
    SELL_CFG.weights.w3 * (-avgMaxDrawdownPct / 10),
  );

  // 慢發訊號的真實輕重：d5/d10/d20 收斂 alpha 取最負（嚴重度判決用此，避免只看 d5 漏掉慢跌）。
  const worstFwdAlphaShrunk = round2(Math.min(
    byHorizon.d5.alphaShrunkPct, byHorizon.d10.alphaShrunkPct, byHorizon.d20.alphaShrunkPct,
  ));

  const firingsN = firings.length;
  const underpowered = firingsN < SELL_CFG.MIN_FIRINGS;
  const verdict = severityVerdict(declaredSeverity, worstFwdAlphaShrunk, underpowered);

  const sampleFirings: SellSampleFiring[] = [...firings]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8)
    .map((f) => ({
      date: f.date, symbol: f.symbol, name: f.name, base: round2(f.base),
      d5: f.m.d5, maxDrawdown: f.m.maxDrawdown, inContext: f.inContext,
    }));

  const volSuspectShare = firingsN ? round2((firings.filter((f) => f.volSuspect).length / firingsN) * 100) : 0;

  return {
    signalType, label, family, market, scope, declaredSeverity,
    firings: firingsN, byHorizon,
    avgMaxDrawdownPct, avgMaxGainPct: round2(mean(mgs)), avgGapReturnPct: round2(mean(gaps)),
    downHit3Pct: round2(mean(hit3vals) * 100), downHit5Pct: round2(mean(hit5vals) * 100),
    downHit3ExcessPct, downHit5ExcessPct: round2(mean(hit5excess)),
    alphaD5, alphaD5Shrunk, worstFwdAlphaShrunk, heavinessScore,
    tStat, significant: Math.abs(tStat) > 2,
    stable, alphaD5EarlyHalf: aEarly, alphaD5LateHalf: aLate,
    volSuspectShare, underpowered, severityVerdict: verdict,
    sampleFirings,
  };
}

/** 手寫嚴重度 vs 實測輕重。empiricalAlpha = worst-of-{d5,d10,d20} 收斂 alpha。 */
export function severityVerdict(
  declared: DeclaredSeverity, empiricalAlpha: number, underpowered: boolean,
): SeverityVerdict {
  if (declared == null) return 'n/a';
  if (underpowered) return 'n/a';
  const t = SELL_CFG.empiricalTier;
  const empRank = empiricalAlpha <= t.heavy ? 2 : empiricalAlpha <= t.medium ? 1 : 0; // 2=heavy
  const decRank = declared === 'high' ? 2 : declared === 'medium' ? 1 : 0;
  if (empRank === decRank) return 'agree';
  return empRank > decRank ? 'underrated' : 'overrated';
}

// ── 全訊號聚合（loops 訊號型別 × 情境）──────────────────────────────────────
export interface SignalMeta { signalType: string; label: string; family: SignalFamily; declaredSeverity: DeclaredSeverity }

export function buildSignalStats(
  market: Market,
  firingsByType: Map<string, FiringRecord[]>,
  metaByType: Map<string, SignalMeta>,
  cohort: CohortAccumulator,
): SignalStat[] {
  const out: SignalStat[] = [];
  for (const [type, recs] of firingsByType) {
    const meta = metaByType.get(type) ?? { signalType: type, label: type, family: 'book' as SignalFamily, declaredSeverity: null };
    for (const scope of SELL_SCOPES) {
      const subset = scope === 'all' ? recs : recs.filter((f) => f.inContext);
      if (subset.length === 0) continue;
      out.push(aggregateSignal(type, meta.label, meta.family, meta.declaredSeverity, market, scope, subset, cohort));
    }
  }
  return out;
}

// ── Markdown 報告 ─────────────────────────────────────────────────────────────
const fmtSigned = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(2);
const sevZh = (s: DeclaredSeverity): string => s === 'high' ? '高' : s === 'medium' ? '中' : s === 'low' ? '低' : '—';
const verdictZh = (v: SeverityVerdict): string =>
  v === 'agree' ? '相符' : v === 'overrated' ? '⚠高估' : v === 'underrated' ? '⚠低估' : '—';
const famZh = (f: SignalFamily): string => f === 'book' ? '書本' : f === 'sanse' ? '三色' : '組合';

function headlineTable(rows: SignalStat[]): string[] {
  const L: string[] = [];
  L.push('| 訊號 | 家族 | 宣告 | 觸發 | d5 α | d10 α | d20 α | 平均最大回落 | 跌≥3%超額 | 穩定 | 顯著 | 評語 |');
  L.push('|---|---|---|---:|---:|---:|---:|---:|---:|:--:|:--:|---|');
  const sorted = [...rows].sort((a, b) => a.alphaD5Shrunk - b.alphaD5Shrunk); // 越負越重 → 最重在上
  for (const r of sorted) {
    L.push(
      `| **${r.label}** | ${famZh(r.family)} | ${sevZh(r.declaredSeverity)} | ${r.firings} | ` +
      `${fmtSigned(r.byHorizon.d5.alphaShrunkPct)} | ${fmtSigned(r.byHorizon.d10.alphaShrunkPct)} | ${fmtSigned(r.byHorizon.d20.alphaShrunkPct)} | ` +
      `${fmtSigned(r.avgMaxDrawdownPct)} | ${fmtSigned(r.downHit3ExcessPct)}pt | ` +
      `${r.stable ? '✓' : '·'} | ${r.significant ? '✓' : '·'} | ${verdictZh(r.severityVerdict)} |`,
    );
  }
  return L;
}

export function buildSellHeavinessMarkdown(doc: SellHeavinessDoc): string {
  const L: string[] = [];
  L.push('# 賣出訊號「輕重」回測 — 哪些賣訊一出現就該立刻動作');
  L.push('');
  L.push(`產出：${doc.generatedAt}　|　視窗：${doc.window.start} ~ ${doc.window.end}（${doc.window.tradingDays} 交易日, label=${doc.window.label}, 排除尾端 ${doc.window.forwardTd} 交易日）`);
  L.push('');
  L.push('**讀法**：把每個賣訊當「離散事件」，逐根回放全市場。基準＝**訊號日收盤**（賣訊最重要的警告是隔夜跳空，用隔日開盤當基準會丟掉它；這量的是「資訊含量／急迫度」不是可成交 P&L）。');
  L.push('- **dN α** = 訊號 dN 平均報酬 − 同日同儕宇宙平均（同情境），再做 prior=0 的 Bayesian shrink。**越負＝越重**（訊號後跌得比大盤同儕更兇）。表格依 **d5 α** 由負到正排（最重在上）。');
  L.push('  同時列 d10/d20 α 是因為部分訊號「慢發」——d5 看似溫和、d10/d20 才見真章（如急漲後長黑、跌破智能線）。');
  L.push('- **同儕** = 該掃描日成交額 top-N 宇宙的平均報酬（控制行情：扣掉「整個盤在跌」的成分）。');
  L.push('- **跌≥3%超額** = 訊號 5 日內盤中跌 ≥3% 的比例 − 同儕同情境基準（百分點）。**平均最大回落** = 窗內最低相對收盤。');
  L.push('- **穩定** = 半窗 early/late alphaD5 同號且倍率 < 2×；**顯著** = |t| > 2（firing 非 iid，t 僅啟發式）。');
  L.push(`- **評語**：手寫嚴重度 vs 實測（取 d5/d10/d20 最負的收斂 alpha 分級：heavy ≤ ${SELL_CFG.empiricalTier.heavy}、medium ≤ ${SELL_CFG.empiricalTier.medium}）。⚠高估＝標太重其實輕；⚠低估＝標太輕其實重。此判決是**本視窗本市場**特定（台股 2 年偏多頭、陸股震盪，故同訊號兩市場輕重不同）。`);
  L.push('');
  L.push(`> ⚠️ **存活者偏誤（方向與買方相反）**：${doc.meta.survivorshipNote}`);
  L.push(`> 樣本門檻：觸發數 ≥ ${doc.meta.minFirings} 才進 headline（不足者列在「樣本不足」區）。`);
  L.push('');
  L.push('---');
  L.push('');

  for (const mkt of ['TW', 'CN'] as Market[]) {
    const mktRows = doc.signals.filter((s) => s.market === mkt);
    L.push(`## ${mkt === 'TW' ? '台股' : '陸股'}`);
    L.push('');
    if (mktRows.length === 0) { L.push('_（無足量樣本）_'); L.push(''); continue; }

    // 1. 輕重排行（持股情境）
    const up = mktRows.filter((s) => s.scope === 'uptrend');
    const upRanked = up.filter((s) => !s.underpowered);
    const upWeak = up.filter((s) => s.underpowered);
    L.push('### 1. 輕重排行 — 持股情境（in-uptrend：仍在多頭、值得抱的股）');
    L.push('');
    L.push(...headlineTable(upRanked));
    L.push('');
    if (upWeak.length) {
      L.push(`<details><summary>樣本不足（觸發 < ${doc.meta.minFirings}，僅供參考）</summary>`);
      L.push('');
      L.push(...headlineTable(upWeak));
      L.push('');
      L.push('</details>');
      L.push('');
    }

    // 2. 嚴重度驗證（只看 book，有手寫 severity）
    L.push('### 2. 手寫嚴重度驗證（book 訊號）');
    L.push('');
    const book = up.filter((s) => s.family === 'book' && !s.underpowered);
    const mismatches = book.filter((s) => s.severityVerdict === 'overrated' || s.severityVerdict === 'underrated');
    if (mismatches.length === 0) {
      L.push('_（持股情境下，所有足量 book 訊號的手寫嚴重度與實測一致。）_');
    } else {
      L.push('| 訊號 | 手寫 | 實測最負 α(d5/d10/d20) | 判決 |');
      L.push('|---|:--:|---:|---|');
      for (const s of [...mismatches].sort((a, b) => a.worstFwdAlphaShrunk - b.worstFwdAlphaShrunk)) {
        L.push(`| ${s.label} | ${sevZh(s.declaredSeverity)} | ${fmtSigned(s.worstFwdAlphaShrunk)} | ${verdictZh(s.severityVerdict)} |`);
      }
    }
    L.push('');

    // 3. 情境敏感度（uptrend vs all 的 alphaD5 差）
    L.push('### 3. 情境敏感度 — 哪些訊號「因為你在多頭持股中」才重');
    L.push('');
    const allByType = new Map(mktRows.filter((s) => s.scope === 'all').map((s) => [s.signalType, s]));
    const sens = up
      .filter((s) => !s.underpowered && allByType.has(s.signalType))
      .map((s) => ({ s, delta: round2(s.alphaD5Shrunk - (allByType.get(s.signalType)!.alphaD5Shrunk)) }))
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 10);
    L.push('| 訊號 | 持股情境 alphaD5 | 全部 alphaD5 | 差（越負＝越靠持股情境才重） |');
    L.push('|---|---:|---:|---:|');
    for (const { s, delta } of sens) {
      const allS = allByType.get(s.signalType)!;
      L.push(`| ${s.label} | ${fmtSigned(s.alphaD5Shrunk)} | ${fmtSigned(allS.alphaD5Shrunk)} | ${fmtSigned(delta)} |`);
    }
    L.push('');

    // 4. 共現警語
    const co = doc.coOccurrence[mkt] ?? {};
    const pairs: { a: string; b: string; p: number }[] = [];
    for (const a of Object.keys(co)) for (const b of Object.keys(co[a])) if (co[a][b] >= 0.4) pairs.push({ a, b, p: co[a][b] });
    pairs.sort((x, y) => y.p - x.p);
    if (pairs.length) {
      L.push('### 4. 同根共現（多重共線性警語）');
      L.push('');
      L.push('> 以下訊號常同根觸發，輕重數字彼此相關、**不可相加**當獨立證據。');
      L.push('');
      L.push('| A 觸發時 | 同根也觸發 B | P(B\\|A) |');
      L.push('|---|---|---:|');
      for (const { a, b, p } of pairs.slice(0, 15)) L.push(`| ${a} | ${b} | ${(p * 100).toFixed(0)}% |`);
      L.push('');
    }

    // 5. 樣本 firing（最重 3 個）
    L.push('### 5. 樣本觸發（最重 3 訊號，供抽查）');
    L.push('');
    for (const s of [...upRanked].sort((a, b) => a.alphaD5Shrunk - b.alphaD5Shrunk).slice(0, 3)) {
      L.push(`**${s.label}**（觸發 ${s.firings}，alphaD5 ${fmtSigned(s.alphaD5Shrunk)}）`);
      L.push('');
      L.push('| 日期 | 代號 | 名稱 | 收盤基準 | d5 | 最大回落 |');
      L.push('|---|---|---|---:|---:|---:|');
      for (const f of s.sampleFirings) {
        L.push(`| ${f.date} | ${f.symbol} | ${f.name} | ${f.base} | ${f.d5 == null ? '—' : fmtSigned(f.d5)} | ${f.maxDrawdown == null ? '—' : fmtSigned(f.maxDrawdown)} |`);
      }
      L.push('');
    }

    L.push('---');
    L.push('');
  }

  L.push('### 方法註記');
  for (const note of doc.meta.notes) L.push(`- ${note}`);
  L.push('');
  return L.join('\n');
}
