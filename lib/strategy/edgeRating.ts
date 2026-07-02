/**
 * 誠實 edge 評級 — 單一事實（A1）
 *
 * 讀 scripts/compute-honest-edge.ts 產出的 data/backtest/honest-edge-ranking.json，
 * 對外提供「某策略扣成本、比大盤後的淨 edge + 評級」。全站凡顯示策略「有沒有用」
 * 一律走這裡，不可再把 raw 報酬當 alpha。
 *
 * 評級語意（family 顆粒度，去重「同策略×多排序」灌水）：
 *   keep  精華候選 — 寬鬆基準下扣成本仍 d5 淨超額 ≥ +0.5% 且樣本 ≥100（需精算二確，非保證）
 *   thin  幾乎打平大盤 — 扣成本後 0 ~ +0.5%
 *   info  輸大盤一點 — −0.5% ~ 0%，當資訊看別當買訊
 *   avoid 顯著輸大盤 — < −0.5%
 *
 * ⚠️ 數字是「寬鬆近似」（指數基準用視窗平均、未逐筆對齊；未扣存活偏差/過擬合）→ 偏向策略。
 *    連這寬鬆基準都贏不了＝穩健沒 edge。標 keep 者仍需逐日對齊精算二次確認。
 */

// 純模組（無 IO）— client / route / script 任意 import。讀檔在 edgeRatingStorage.ts。

export type EdgeGrade = 'keep' | 'thin' | 'info' | 'avoid';
export type Market = 'TW' | 'CN';

export interface HonestEdgeRow {
  id: string;
  market: Market;
  engine: 'buymethod' | 'sanse';
  strategyId: string;
  strategyLabel: string;
  sortLabel: string;
  track: string | null;
  days: number;
  nTop1: number;
  nCohort: number;
  raw: { top1D5: number; cohortD5: number; sortAlphaD5: number; top1WinPct: number };
  excess: { top1D5: number; cohortD5: number };
  netEdge: { top1D5: number; cohortD5: number };
  grade: EdgeGrade;
  honestNote: string;
}

export interface HonestEdgeFamily {
  market: Market;
  strategyId: string;
  strategyLabel: string;
  engine: 'buymethod' | 'sanse';
  track: string | null;
  bestNetD5: number;
  bestSort: string;
  maxN: number;
  sortVariants: number;
  grade: EdgeGrade;
}

export interface HonestEdgeDoc {
  generatedAt: string;
  sourceLeaderboard: string;
  method: string;
  costRoundTripPct: Record<Market, number>;
  indexAvgForwardPct: Record<Market, { d1: number; d3: number; d5: number }>;
  window: { start: string; end: string; tradingDays: number; label: string };
  caveats: string[];
  counts: Record<EdgeGrade, number>;
  familyCounts: Record<EdgeGrade, number>;
  families: HonestEdgeFamily[];
  rows: HonestEdgeRow[];
}

// ── 顯示用評級 meta（emoji/標籤/色調，UI 共用，不寫死於各頁）──────────────────────
export const GRADE_META: Record<EdgeGrade, { label: string; emoji: string; tone: 'good' | 'neutral' | 'warn' | 'bad' }> = {
  keep:  { label: '精華候選', emoji: '🟢', tone: 'good' },
  thin:  { label: '幾乎打平大盤', emoji: '🟡', tone: 'neutral' },
  info:  { label: '輸大盤·當資訊', emoji: '⚪', tone: 'warn' },
  avoid: { label: '顯著輸大盤', emoji: '🔴', tone: 'bad' },
};

export const GRADE_ORDER: Record<EdgeGrade, number> = { keep: 0, thin: 1, info: 2, avoid: 3 };

/** 全站誠實說明（首頁掃描 tab + 排行榜頁共用，白話、不灌假希望）。 */
export const HONEST_EDGE_DISCLAIMER =
  '誠實說明：這些策略經 2 年回測，扣掉手續費與「大盤本來就漲」後，多數打不贏大盤、勝率多在 5 成以下。' +
  '本工具真正能幫你的是控制虧損、避開陷阱、紀律執行，不是保證選到飆股。下列數字為寬鬆近似，僅供相對參考。';

// ── 查詢 helper（建索引；route/page 載入 doc 後重複查用）──────────────────────────
export interface EdgeIndex {
  doc: HonestEdgeDoc;
  rowById: Map<string, HonestEdgeRow>;
  familyByKey: Map<string, HonestEdgeFamily>;
}

export function buildEdgeIndex(doc: HonestEdgeDoc): EdgeIndex {
  const rowById = new Map<string, HonestEdgeRow>();
  for (const r of doc.rows) rowById.set(r.id, r);
  const familyByKey = new Map<string, HonestEdgeFamily>();
  for (const f of doc.families) familyByKey.set(`${f.market}:${f.strategyId}`, f);
  return { doc, rowById, familyByKey };
}

/** 某策略家族（市場×strategyId）的評級；查不到回 null（未回測過的軌如 V/W）。 */
export function familyRating(idx: EdgeIndex | null, market: Market, strategyId: string): HonestEdgeFamily | null {
  return idx?.familyByKey.get(`${market}:${strategyId}`) ?? null;
}

/** 某 (策略×排序) 列的評級；id 同 leaderboard row id。 */
export function rowRating(idx: EdgeIndex | null, rowId: string): HonestEdgeRow | null {
  return idx?.rowById.get(rowId) ?? null;
}
