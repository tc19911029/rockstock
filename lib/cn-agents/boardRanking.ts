/**
 * 陸股板塊排行（/cn-sectors 熱門板塊視圖）— 2026-06-19
 *
 * 純顯示層，與台股 /sectors 同性質：板塊強弱「描述性」呈現，**不參與選股 gate**（鐵則 #5）。
 * 板塊分類用東方財富現成（行業 ~496 / 概念 ~494），盤後 cn-agents-eod cron 已每日抓存
 * data/cn-agents/boards/{date}.json，本模組只在讀取時加掛兩個衍生欄：
 *
 *   1. 輪動（rotation）：今日 vs 約 5 個交易日前的「5 日漲幅排名」變化（鏡像台股 themeRotation）：
 *      rankDelta = 前次名次 − 今日名次（正 = 名次爬升 = 資金轉入）；分桶 ≥3 轉入 / ≤-3 轉出 / 其餘主流。
 *      ⚠️ 描述性，非買賣訊號。
 *   2. 階段（stage）：用手上欄位 pct(今日%)、pct5d(5日%)、mainNetCny(主力淨流入) 的顯示用
 *      heuristic 分類，**非回測驗證**，僅供盯盤一眼分辨「剛啟動/主升/高潮/退潮/盤整」。
 *
 * rotation / stage 兩個 pure 函式有單元測試（__tests__/cn-board-ranking.test.ts）守。
 */

import type { BoardEntry } from './types';
import { readBoardsDay, listBoardsDates } from './storage';

export type CnBoardStage = '剛啟動' | '主升段' | '高潮噴出' | '退潮' | '盤整';

export type CnRotationBucket = 'in' | 'mid' | 'out';

export interface CnBoardRotation {
  /** 今日 5 日強弱名次（1 = 最強；同 kind 內） */
  rankNow: number;
  /** 約 5 日前名次；無 prior = null */
  rankPrev: number | null;
  /** 名次變化（prior − now；正 = 爬升）；無 prior = null */
  rankDelta: number | null;
  bucket: CnRotationBucket;
}

export interface CnRankedBoard extends BoardEntry {
  rotation: CnBoardRotation | null;
  stage: CnBoardStage;
}

export interface CnBoardRankingFile {
  date: string;
  /** 算輪動用的前一檔日期（約 5 交易日前）；無 = null */
  priorDate: string | null;
  generatedAt: string;
  concepts: CnRankedBoard[];
  industries: CnRankedBoard[];
}

const RANK_DELTA_TH = 3;
/** 輪動比較跨幾個交易日（取 listBoardsDates 的索引回退量）。2026-06-19 改日線＝1（昨天）。 */
const ROTATION_LOOKBACK = 1;

/**
 * 板塊階段 heuristic（顯示用，非回測）。優先序由「最該標出的狀態」往下：
 *   退潮   ：近 5 日轉弱（pct5d ≤ -3）
 *   高潮噴出：近 5 日大漲且今天還在衝（pct5d ≥ 8 且 pct ≥ 2）
 *   主升段 ：近 5 日續強（pct5d ≥ 4 且 pct > 0）
 *   剛啟動 ：近 5 日剛轉強（pct5d ≥ 1.5 且 pct ≥ 0.5）
 *   盤整   ：其餘
 * pct5d 缺值（歷史不足）→ 只看今日 pct 粗分（≥2 剛啟動 / ≤-2 退潮 / 其餘盤整）。
 */
export function classifyBoardStage(b: Pick<BoardEntry, 'pct' | 'pct5d'>): CnBoardStage {
  const { pct, pct5d } = b;
  if (pct5d == null) {
    if (pct >= 2) return '剛啟動';
    if (pct <= -2) return '退潮';
    return '盤整';
  }
  if (pct5d <= -3) return '退潮';
  if (pct5d >= 8 && pct >= 2) return '高潮噴出';
  if (pct5d >= 4 && pct > 0) return '主升段';
  if (pct5d >= 1.5 && pct >= 0.5) return '剛啟動';
  return '盤整';
}

/** 同 kind 內按「今日漲幅 pct」（缺值沉底）排出名次 map：code → 1-based 名次。 */
function rankByTodayPct(boards: BoardEntry[]): Map<string, number> {
  const sorted = [...boards].sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));
  const m = new Map<string, number>();
  sorted.forEach((e, i) => m.set(e.code, i + 1));
  return m;
}

/**
 * 算一組板塊（同 kind）的輪動：今日漲幅名次 vs 昨天（prior 傳前一交易日）。
 * 2026-06-19 改日線（原本用 5 日漲幅名次比 5 交易日前，反應太慢）。
 * prior 為 null（無前一檔）→ 全部 rankDelta=null、bucket='mid'。
 */
export function computeBoardRotation(
  today: BoardEntry[],
  prior: BoardEntry[] | null,
): Map<string, CnBoardRotation> {
  const nowRank = rankByTodayPct(today);
  const prevRank = prior ? rankByTodayPct(prior) : null;
  const out = new Map<string, CnBoardRotation>();
  for (const b of today) {
    const rankNow = nowRank.get(b.code)!;
    const rankPrev = prevRank?.get(b.code) ?? null;
    const rankDelta = rankPrev != null ? rankPrev - rankNow : null;
    let bucket: CnRotationBucket = 'mid';
    if (rankDelta != null) {
      if (rankDelta >= RANK_DELTA_TH) bucket = 'in';
      else if (rankDelta <= -RANK_DELTA_TH) bucket = 'out';
    }
    out.set(b.code, { rankNow, rankPrev, rankDelta, bucket });
  }
  return out;
}

/** 把一組板塊加掛 rotation + stage（rotation 來自 computeBoardRotation 的 map）。 */
function enrich(boards: BoardEntry[], rot: Map<string, CnBoardRotation>): CnRankedBoard[] {
  return boards.map((b) => ({
    ...b,
    rotation: rot.get(b.code) ?? null,
    stage: classifyBoardStage(b),
  }));
}

/**
 * 組某日板塊排行（含輪動 + 階段）。該日無 boards 檔 → null。
 * 輪動的 prior = listBoardsDates 中該日往前數 ROTATION_LOOKBACK 個有檔的日期（不足取最早）。
 */
export async function buildCnBoardRanking(date: string): Promise<CnBoardRankingFile | null> {
  const today = await readBoardsDay(date);
  if (!today) return null;

  const dates = await listBoardsDates();
  const idx = dates.indexOf(date);
  let priorDate: string | null = null;
  if (idx > 0) priorDate = dates[Math.max(0, idx - ROTATION_LOOKBACK)];
  const prior = priorDate && priorDate !== date ? await readBoardsDay(priorDate) : null;

  const conceptRot = computeBoardRotation(today.concepts, prior?.concepts ?? null);
  const industryRot = computeBoardRotation(today.industries, prior?.industries ?? null);

  return {
    date,
    priorDate: prior ? priorDate : null,
    generatedAt: new Date().toISOString(),
    concepts: enrich(today.concepts, conceptRot),
    industries: enrich(today.industries, industryRot),
  };
}

/** 最新有 boards 檔的那日排行；完全無資料 → null。 */
export async function buildLatestCnBoardRanking(): Promise<CnBoardRankingFile | null> {
  const dates = await listBoardsDates();
  if (dates.length === 0) return null;
  return buildCnBoardRanking(dates[dates.length - 1]);
}
