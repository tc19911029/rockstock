// ============================================================
// 三色資金 — 條件分桶 + 期望漲幅排序（單一事實來源）
//
// 這支被三個地方共用，保證「桶定義 / 排序分數」三方一致：
//   1. lib/cn-sanse/backtestResonance.ts  → 30 天即時回測（API fallback）
//   2. scripts/backtest-cn-sanse-rerank.ts → 全期深度回測 + walk-forward 驗證
//   3. app/cn-sanse/page.tsx               → 前端「依期望漲幅」重排
//
// 純函式、無 IO，可在 client / script / route 任意 import。
// 不從 ./scan import（避免把 fs 牽進 client bundle）；改用結構相容的 RankRecord。
// ============================================================

import type { ConditionReport } from './conditions';
import { getLimitMovePct } from '@/lib/utils/limitRules';

/** 排序/回測只需要這幾個欄位 — ResonanceRecord 與前端 RecordRow 都結構相容。 */
export interface RankRecord {
  changePct: number;
  report: ConditionReport;
  /** 板塊敏感漲停門檻用；缺則退主板 10%（舊資料相容）。 */
  symbol?: string;
}

export const BT_HORIZONS = [
  { key: 'openReturn', label: '隔日開' },
  { key: 'd1Return', label: '1日' },
  { key: 'd3Return', label: '3日' },
  { key: 'd5Return', label: '5日' },
  { key: 'd10Return', label: '10日' },
  { key: 'd20Return', label: '20日' },
  { key: 'maxGain', label: '最高' },
  { key: 'maxLoss', label: '最低' },
] as const;
export type HKey = (typeof BT_HORIZONS)[number]['key'];
export const WINRATE_KEYS = new Set<HKey>(['openReturn', 'd1Return', 'd3Return', 'd5Return', 'd10Return', 'd20Return']);

/** 可當排序基準的 horizon（漲幅類，排除 maxLoss / openReturn）。 */
export const RANK_HORIZONS: { key: HKey; label: string }[] = [
  { key: 'd3Return', label: '3日收盤' },
  { key: 'd5Return', label: '5日收盤' },
  { key: 'd10Return', label: '10日收盤' },
  { key: 'maxGain', label: '窗內最高' },
];

export interface BucketStat {
  key: string; label: string; group: string; n: number;
  cnt: Record<HKey, number>;           // 各 horizon 有效樣本數（shrinkage 用）
  avg: Record<HKey, number | null>;     // 平均報酬 %
  win: Record<HKey, number | null>;     // 勝率 %（僅報酬類有意義）
}

/** 桶定義（顯示順序）。ALL=全體基準；主力階段×指標買點為排序主桶，其餘為描述維度。 */
const STAGES: { k: string; label: string }[] = [
  { k: 'full', label: '滿分⭐' }, { k: 'develop', label: '發展📈' }, { k: 'ignite', label: '點火🔥' },
];
export const BUCKET_DEFS: { key: string; label: string; group: string }[] = [
  { key: 'ALL', label: '全體基準', group: '基準' },
  ...STAGES.flatMap((s) => [
    { key: s.k, label: `${s.label} 單獨`, group: s.label },
    { key: `${s.k}+b`, label: `${s.label} +雙B`, group: s.label },
    { key: `${s.k}+c`, label: `${s.label} +捕撈`, group: s.label },
    { key: `${s.k}+bc`, label: `${s.label} +雙指標`, group: s.label },
  ]),
  { key: 'observe+b', label: '觀察 雙B買', group: '觀察區(主力未入選)' },
  { key: 'observe+c', label: '觀察 捕撈買', group: '觀察區(主力未入選)' },
  { key: 'lvl_strong', label: '強共振 3/3', group: '共振等級' },
  { key: 'lvl_medium', label: '中共振 2/3', group: '共振等級' },
  { key: 'lvl_weak', label: '弱共振 1/3', group: '共振等級' },
  { key: 'b_reson', label: '雙箭頭共振(金叉+突破)', group: '雙B訊號型' },
  { key: 'b_goldonly', label: '純黃紅金叉', group: '雙B訊號型' },
  { key: 'b_breakonly', label: '純突破交易線', group: '雙B訊號型' },
  { key: 'c_bull', label: '多頭區金叉', group: '捕撈型' },
  { key: 'c_bear', label: '空頭區金叉(底反)', group: '捕撈型' },
  { key: 'c_vol', label: '量價強勢(金叉+爆量)', group: '捕撈型' },
  { key: 'm_three', label: '主力三色齊(紅+紫+黃)', group: '主力三色' },
  { key: 'allin', label: '全都有(雙B突破+金叉·三色·捕撈金叉+量柱)', group: '超級組合' },
  { key: 'limitup', label: '掃描日漲停(追停)', group: '掃描日漲停' },
  { key: 'notlimitup', label: '掃描日未漲停', group: '掃描日漲停' },
  { key: 'noconflict', label: '無衝突', group: '衝突' },
  { key: 'conflict', label: '有衝突', group: '衝突' },
];

/** 一筆紀錄所屬的全部桶（用於回測累計 — 一筆會落入多個桶）。 */
export function bucketsForRecord(r: RankRecord): string[] {
  const keys: string[] = ['ALL'];
  const rep = r.report;
  const hasB = rep.doubleB.buyHit;
  const hasC = rep.catch.buyHit;
  if (rep.mainStage) {
    keys.push(rep.mainStage);
    if (hasB) keys.push(`${rep.mainStage}+b`);
    if (hasC) keys.push(`${rep.mainStage}+c`);
    if (hasB && hasC) keys.push(`${rep.mainStage}+bc`);
  } else {
    if (hasB) keys.push('observe+b');
    if (hasC) keys.push('observe+c');
  }
  if (rep.level === 'strong') keys.push('lvl_strong');
  else if (rep.level === 'medium') keys.push('lvl_medium');
  else if (rep.level === 'weak') keys.push('lvl_weak');
  if (hasB) {
    const reson = rep.doubleB.buy.some((c) => c.id === 'b_resonance' && c.met);
    const gold = rep.doubleB.buy.some((c) => c.id === 'b_gold' && c.met);
    const brk = rep.doubleB.buy.some((c) => c.id === 'b_break' && c.met);
    if (reson || (gold && brk)) keys.push('b_reson');
    else if (gold) keys.push('b_goldonly');
    else if (brk) keys.push('b_breakonly');
  }
  const cVol = rep.catch.buy.some((c) => c.id === 'c_gold_vol' && c.met); // 量價強勢(金叉+爆量)
  if (hasC) {
    if (rep.catch.buy.some((c) => c.id === 'c_gold_bull' && c.met)) keys.push('c_bull');
    else if (rep.catch.buy.some((c) => c.id === 'c_gold_bear' && c.met)) keys.push('c_bear');
    if (cVol) keys.push('c_vol');
  }
  const mThree = rep.mainforce.buy.some((c) => c.id === 'm_three' && c.met); // 三色齊(紅+紫+黃)
  if (mThree) keys.push('m_three');
  // 全都有超級組合：雙B 突破+金叉 + 主力三色齊 + 捕撈金叉 + 量柱
  const bothB = rep.doubleB.buy.some((c) => c.id === 'b_break' && c.met)
    && rep.doubleB.buy.some((c) => c.id === 'b_gold' && c.met);
  if (bothB && mThree && hasC && cVol) keys.push('allin');
  // 漲停門檻板塊敏感：主板 9.5%、科創/創業 19.5%（缺 symbol 退主板）。
  const limitThr = r.symbol ? getLimitMovePct('CN', r.symbol) * 100 - 0.5 : 9.5;
  keys.push(r.changePct >= limitThr ? 'limitup' : 'notlimitup');
  keys.push(rep.conflict ? 'conflict' : 'noconflict');
  return keys;
}

/** 排序主桶 = 最具體的「主力階段×指標買點」桶；觀察區回退 observe 桶；皆無 → null。 */
export function primaryBucketKey(r: RankRecord): string | null {
  const rep = r.report;
  const hasB = rep.doubleB.buyHit;
  const hasC = rep.catch.buyHit;
  if (rep.mainStage) {
    if (hasB && hasC) return `${rep.mainStage}+bc`;
    if (hasB) return `${rep.mainStage}+b`;
    if (hasC) return `${rep.mainStage}+c`;
    return rep.mainStage;
  }
  if (hasB) return 'observe+b';
  if (hasC) return 'observe+c';
  return null;
}

export interface ExpectedGainOpts {
  /** Bayesian shrinkage 常數：n→0 時退回全體均值，n≫K 時逼近桶均值。 */
  shrinkK?: number;
}

/**
 * 一筆紀錄在某 horizon 的「期望漲幅」分數。
 * = 排序主桶該 horizon 的縮放後平均報酬：(n·桶均 + K·全體均)/(n+K)。
 * 小樣本桶被拉回全體均值，避免僥倖高報酬桶霸佔第一。
 */
export function expectedGainScore(
  r: RankRecord,
  buckets: BucketStat[],
  horizon: HKey,
  opts: ExpectedGainOpts = {},
): number {
  const K = opts.shrinkK ?? 20;
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const globalAvg = byKey.get('ALL')?.avg[horizon] ?? 0;
  const key = primaryBucketKey(r);
  const b = key ? byKey.get(key) : undefined;
  const avg = b?.avg[horizon];
  if (b == null || avg == null) return globalAvg;
  const n = b.cnt?.[horizon] ?? b.n ?? 0;
  return (n * avg + K * globalAvg) / (n + K);
}

/**
 * 依期望漲幅重排（只改順序、集合不變）。
 * tiebreak 沿用舊排序鍵：共振組數 → 短線上攻，行為可預期。
 */
export function rerankRecords<T extends RankRecord>(
  records: T[],
  buckets: BucketStat[],
  horizon: HKey,
  opts?: ExpectedGainOpts,
): T[] {
  return records
    .map((r) => ({ r, score: expectedGainScore(r, buckets, horizon, opts) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.r.report.groupBuyCount - a.r.report.groupBuyCount ||
        b.r.report.scores.shortAttack - a.r.report.scores.shortAttack,
    )
    .map((s) => s.r);
}
