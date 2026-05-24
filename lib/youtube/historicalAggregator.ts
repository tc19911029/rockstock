/**
 * 跨日聚合 — MVP 6 報告匯出 + 跨日趨勢的資料層。
 *
 * 從 data/youtube/analysis/{date}.json 讀多日資料，聚合出：
 *   - 每檔股票跨日 mention_count、評級分佈、最近 sentiment、評級變化
 *   - 每個 source 跨日活躍度
 *
 * 設計：純讀取、無 cache（前端會 60s refresh）。聚合 30 天上限。
 */

import { loadDailyAnalysis, type DailyAnalysis, type AnalyzedStockMention, type StockRating } from './analysisStorage';
import { loadSources } from './videoStorage';

export interface RangeDays {
  range_days: number;          // 7 / 30
  end_date: string;            // YYYY-MM-DD inclusive
  /** 實際聚合到的 analysis 檔案數（不是 range_days，因為週末/假日可能沒資料） */
  analyses_loaded: number;
}

export interface StockTrendRow {
  stock_code: string;
  stock_name: string;
  /** 跨日 mention 總次數（不去重；同一天多節目都算） */
  total_mentions: number;
  /** 跨日被提到的天數 */
  days_mentioned: number;
  /** 累計 bullish mention 數 */
  bullish_count: number;
  /** 累計 bearish/risk_warning mention 數 */
  bearish_count: number;
  /** 整體傾向 */
  sentiment: 'bullish' | 'bearish' | 'mixed' | 'neutral';
  /** 最近一次評級（latest analysis 內若有 scoring） */
  latest_rating: StockRating | null;
  latest_composite_score: number | null;
  /** 整段期間平均 composite score（只算有 scoring 的日子） */
  avg_composite_score: number | null;
  /** 評級分佈 — 該股出現過的所有 rating */
  rating_distribution: { A: number; B: number; C: number; D: number };
  /** 提到該股的不同節目來源數 */
  source_diversity: number;
  /** 出現的所有日期 (newest first) */
  dates: string[];
}

export interface StockHistoryEntry {
  date: string;
  source_id: string;
  /** 節目顯示名（如「錢線百分百」），sourceRegistry 查不到時退回 source_id */
  display_name: string;
  video_id: string;
  sentiment: AnalyzedStockMention['sentiment'];
  context: string;
  reason: string;
  combined_confidence: number;
  /** 該日的 scoring（若有） */
  rating: StockRating | null;
  composite_score: number | null;
  /** 講這檔股票的分析師（從 mention.analysts 帶下來） */
  analysts: string[];
}

export interface StockHistory {
  stock_code: string;
  stock_name: string;
  entries: StockHistoryEntry[];  // newest first
  /** 簡易評級變化線（每日各一個點，僅有 scoring 的日子） */
  rating_timeline: Array<{ date: string; rating: StockRating; composite_score: number }>;
}

// ── 讀多日 analysis ─────────────────────────────────────────────

function* enumerateDates(endDate: string, rangeDays: number): Generator<string> {
  // endDate 是 inclusive；往前數 rangeDays-1 天
  const end = new Date(endDate + 'T00:00:00Z');
  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(end.getTime() - i * 86400_000);
    yield d.toISOString().slice(0, 10);
  }
}

/** 載入 range_days 範圍內所有 analysis 檔案（按日期降序） */
export async function loadAnalysesInRange(
  endDate: string,
  rangeDays: number,
): Promise<{ meta: RangeDays; analyses: DailyAnalysis[] }> {
  const candidates = Array.from(enumerateDates(endDate, rangeDays));
  const results: DailyAnalysis[] = [];
  for (const d of candidates) {
    const a = await loadDailyAnalysis(d);
    if (a) results.push(a);
  }
  // newest first
  results.sort((a, b) => b.date.localeCompare(a.date));
  return {
    meta: { range_days: rangeDays, end_date: endDate, analyses_loaded: results.length },
    analyses: results,
  };
}

// ── 跨日股票聚合 ────────────────────────────────────────────────

/**
 * 把多日 analyses 聚合成 stock-level trend 表。
 * 過濾掉 combined_confidence < 0.6 的低信心 mention。
 */
export function aggregateStockTrends(analyses: DailyAnalysis[]): StockTrendRow[] {
  // analyses 已是 newest first
  const byCode = new Map<string, {
    stock_name: string;
    mentions: Array<AnalyzedStockMention & { date: string }>;
    scorings: Array<{ date: string; rating: StockRating; composite_score: number }>;
  }>();

  for (const a of analyses) {
    const all = [...a.high_consensus_stocks, ...a.weak_signal_stocks];
    const scoringByCode = new Map(
      (a.stock_scoring ?? []).map(s => [s.stock_code, s]),
    );

    for (const m of all) {
      if (!m.matched) continue;
      if (m.combined_confidence < 0.6) continue;
      const code = m.matched.code;
      let agg = byCode.get(code);
      if (!agg) {
        agg = { stock_name: m.matched.name, mentions: [], scorings: [] };
        byCode.set(code, agg);
      }
      agg.mentions.push({ ...m, date: a.date });

      const sc = scoringByCode.get(code);
      if (sc) {
        // 同日同股可能在 scoringByCode 找到一次；避免重複加
        if (!agg.scorings.some(s => s.date === a.date)) {
          agg.scorings.push({ date: a.date, rating: sc.rating, composite_score: sc.composite_score });
        }
      }
    }
  }

  const rows: StockTrendRow[] = [];
  for (const [code, agg] of byCode.entries()) {
    const dates = Array.from(new Set(agg.mentions.map(m => m.date))).sort().reverse();
    const bullish = agg.mentions.filter(m => m.sentiment === 'bullish').length;
    const bearish = agg.mentions.filter(m => m.sentiment === 'bearish' || m.sentiment === 'risk_warning').length;
    const sourceDiv = new Set(agg.mentions.map(m => m.source_id)).size;

    let sentiment: StockTrendRow['sentiment'];
    if (bullish === 0 && bearish === 0) sentiment = 'neutral';
    else if (bullish > bearish * 2) sentiment = 'bullish';
    else if (bearish > bullish * 2) sentiment = 'bearish';
    else if (bullish === 0) sentiment = 'bearish';
    else if (bearish === 0) sentiment = 'bullish';
    else sentiment = 'mixed';

    // newest scoring (analyses are newest-first, but scorings collected may not be)
    agg.scorings.sort((a, b) => b.date.localeCompare(a.date));
    const latestScoring = agg.scorings[0] ?? null;
    const avgScore = agg.scorings.length > 0
      ? Number((agg.scorings.reduce((s, x) => s + x.composite_score, 0) / agg.scorings.length).toFixed(1))
      : null;

    const ratingDist = { A: 0, B: 0, C: 0, D: 0 };
    for (const s of agg.scorings) ratingDist[s.rating] += 1;

    rows.push({
      stock_code: code,
      stock_name: agg.stock_name,
      total_mentions: agg.mentions.length,
      days_mentioned: dates.length,
      bullish_count: bullish,
      bearish_count: bearish,
      sentiment,
      latest_rating: latestScoring?.rating ?? null,
      latest_composite_score: latestScoring?.composite_score ?? null,
      avg_composite_score: avgScore,
      rating_distribution: ratingDist,
      source_diversity: sourceDiv,
      dates,
    });
  }

  // 預設排序：先 latest_rating（A 在前），再 total_mentions
  const ratingOrder: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };
  rows.sort((x, y) => {
    const xr = x.latest_rating ? ratingOrder[x.latest_rating] : 0;
    const yr = y.latest_rating ? ratingOrder[y.latest_rating] : 0;
    if (xr !== yr) return yr - xr;
    if (x.total_mentions !== y.total_mentions) return y.total_mentions - x.total_mentions;
    return x.stock_code.localeCompare(y.stock_code);
  });

  return rows;
}

// ── 個股歷史 ─────────────────────────────────────────────────────

export async function buildStockHistory(
  analyses: DailyAnalysis[],
  stockCode: string,
): Promise<StockHistory | null> {
  const sources = await loadSources();
  const displayNameById = new Map(sources.map(s => [s.source_id, s.display_name]));

  let stockName = '';
  const entries: StockHistoryEntry[] = [];
  const timeline: Array<{ date: string; rating: StockRating; composite_score: number }> = [];

  for (const a of analyses) {
    const all = [...a.high_consensus_stocks, ...a.weak_signal_stocks];
    const scoring = (a.stock_scoring ?? []).find(s => s.stock_code === stockCode);
    if (scoring) {
      timeline.push({ date: a.date, rating: scoring.rating, composite_score: scoring.composite_score });
    }
    for (const m of all) {
      if (!m.matched) continue;
      if (m.matched.code !== stockCode) continue;
      if (m.combined_confidence < 0.6) continue;
      if (!stockName) stockName = m.matched.name;
      entries.push({
        date: a.date,
        source_id: m.source_id,
        display_name: displayNameById.get(m.source_id) ?? m.source_id,
        video_id: m.video_id,
        sentiment: m.sentiment,
        context: m.context,
        reason: m.reason,
        combined_confidence: m.combined_confidence,
        rating: scoring?.rating ?? null,
        composite_score: scoring?.composite_score ?? null,
        analysts: m.analysts ?? [],
      });
    }
  }

  if (entries.length === 0) return null;

  // newest first（analyses 已是 newest first，這裡 stable sort 後一樣）
  entries.sort((a, b) => b.date.localeCompare(a.date));
  timeline.sort((a, b) => a.date.localeCompare(b.date));  // chart 用 oldest→newest

  return { stock_code: stockCode, stock_name: stockName, entries, rating_timeline: timeline };
}
