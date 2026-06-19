/**
 * 題材輪動「描述性」標籤（2026-06-19）
 *
 * ⚠️ 這是**描述性情境感知**，不是買賣訊號。回測（scripts/backtest-theme-rotation.ts，
 * 隔離 beta 後）證實：輪入🟢只贏全題材平均 ~0.15%/d10、勝率<50%；避退潮🔴無 edge
 * （退潮會均值回歸）。詳見記憶 theme_rotation_no_edge。
 * 因此：只標「錢在進/出哪個題材」供盯盤參考，**不排序成該買、不做避雷名單、不進選股 gate**（鐵則 #5）。
 *
 * 算法：今日 vs 約 5 個交易日前的題材排名（兩份都按 avgD5 排）：
 *   rankDelta = 前次名次 − 今日名次（正 = 名次爬升 = 資金轉入）
 *   accel     = 今日 avgD5 − 前次 avgD5（顯示用：近段動能變化）
 *
 * 分桶純看「相對名次變化」（輪動本來就是錢在題材間搬，是相對的）：
 *   轉入🟢 = rankDelta ≥ 3（名次爬 ≥3 名）
 *   轉出🔴 = rankDelta ≤ -3（名次掉 ≥3 名）
 *   主流🟡 = 中間（±2 內）
 * 2026-06-19 修：原本「轉出」還要求 accel<0，普漲日落後題材仍小漲 → 紅燈不亮、輪動看不出來；
 * 改成只看名次相對變化，普漲日也能正確標出誰被資金拋下（退出）。
 */
import type { SectorRankingFile } from './sectorRanking';

export type RotationBucket = 'in' | 'mid' | 'out';

export interface ThemeRotation {
  /** 今日名次（1 = 最強；依 avgD5 排） */
  rankNow: number;
  /** 約 5 日前名次；無 prior = null */
  rankPrev: number | null;
  /** 名次變化（vs prior；正=爬升）；無 prior = null */
  rankDelta: number | null;
  /** 近段動能變化（avgD5 今日 − prior）；null = 資料不足 */
  accel: number | null;
  bucket: RotationBucket;
}

const RANK_DELTA_TH = 3;

/** 依「今日漲幅 avgD1」排名次（缺值沉底）：theme → 1-based 名次。 */
function rankByD1(themes: SectorRankingFile['themes']): Map<string, number> {
  const sorted = [...themes].sort((a, b) => (b.avgD1 ?? -Infinity) - (a.avgD1 ?? -Infinity));
  const m = new Map<string, number>();
  sorted.forEach((t, i) => m.set(t.theme, i + 1));
  return m;
}

/**
 * 輪動＝「今日漲幅名次」今天 vs 昨天（caller 傳前一交易日檔當 prior）。
 * 2026-06-19 改日線：原本用 5 日漲幅名次、比 ~5 交易日前，反應太慢；改成每天看
 * （今日漲幅排名 vs 昨日漲幅排名），抓「今天資金轉進哪個題材」。
 */
export function computeRotation(
  today: SectorRankingFile,
  prior: SectorRankingFile | null,
): Map<string, ThemeRotation> {
  const nowRank = rankByD1(today.themes);
  const prevRank = prior ? rankByD1(prior.themes) : null;
  const priorD1 = new Map<string, number | null>();
  prior?.themes.forEach((t) => priorD1.set(t.theme, t.avgD1));

  const out = new Map<string, ThemeRotation>();
  for (const t of today.themes) {
    const rankNow = nowRank.get(t.theme)!;
    const rankPrev = prevRank?.get(t.theme) ?? null;
    const rankDelta = rankPrev != null ? rankPrev - rankNow : null;
    const ap = priorD1.get(t.theme);
    const accel = t.avgD1 != null && ap != null ? +(t.avgD1 - ap).toFixed(1) : null;
    let bucket: RotationBucket = 'mid';
    if (rankDelta != null) {
      if (rankDelta >= RANK_DELTA_TH) bucket = 'in';
      else if (rankDelta <= -RANK_DELTA_TH) bucket = 'out';
    }
    out.set(t.theme, { rankNow, rankPrev, rankDelta, accel, bucket });
  }
  return out;
}
