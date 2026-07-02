/**
 * News Agent (Agent B) — 消息面 prefetch + question builder
 *
 * 紅線：
 *   - 只看 YouTube analysis + RSS 新聞
 *   - dataPoints 必須全部 category='news'
 *   - 引用 YouTube 共識時 combined_confidence ≥ 0.6
 *   - 每則新聞必含 source + publishedAt
 *
 * 資料來源：
 *   - /api/youtube/analysis/{date} → DailyAnalysis
 *   - /api/news/{ticker} → NewsAnalysisResult（RSS + sentiment）
 *
 * YouTube prefetch 窗口（解決「T-1 盤後節目隔天才反映」case）：
 *   - 讀 T-1 + T 兩天 analysis 聯集
 *   - 以影片 published_at 過濾窗口 [T-1 01:00 UTC, T 16:00 UTC]
 *     = T-1 09:00 CST 到 T+1 00:00 CST，涵蓋 T-1 盤後 + T 整天
 *   - dedup by video_id
 */

import { fetchJSON, internalUrl, bareTicker } from './_fetchHelper';
import {
  AGENT_SCHEMA_VERSION,
  NewsGroundTruth,
  NewsQuestion,
  NewsRssSummary,
  NewsYouTubeMention,
} from '@/lib/agents/types';
import { NEWS_JUDGMENT_RULES } from '@/lib/agents/judgmentRules';
import type { DailyAnalysis, AnalyzedStockMention } from '@/lib/youtube/analysisStorage';
import type { YouTubeVideo } from '@/lib/youtube/types';
import type { MarketId } from '@/lib/scanner/types';
import type { Candidate } from '@/lib/agents/candidates/types';
import { sliceSourcesForAgent } from '@/lib/agents/candidates/types';

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export interface BuildNewsQuestionArgs {
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  /** 用 candidateRow.name 提示中文名稱（搜尋更準）*/
  name: string;
  /** P3.5：完整 candidate（會切片只塞 youtube source）*/
  candidate?: Candidate;
}

export async function buildNewsQuestion(args: BuildNewsQuestionArgs): Promise<NewsQuestion> {
  const { runId, date, symbol, market, name, candidate } = args;
  const fetchErrors: string[] = [];

  // ── prefetch 並行（YouTube 走 T-1+T 兩日聯集窗口）──
  const [youtubeWindow, rssRaw] = await Promise.all([
    fetchYouTubeWindow(date).catch((e) => {
      fetchErrors.push(`youtube: ${e}`);
      return null;
    }),
    fetchRssNews(symbol).catch((e) => { fetchErrors.push(`news: ${e}`); return null; }),
  ]);

  // ── 從 T-1+T YouTube 兩日聯集提取該 symbol 的 mention 摘要 ──
  const youtube = youtubeWindow
    ? extractYouTubeMentionsInWindow(youtubeWindow, symbol, name)
    : null;

  // ── 從 RSS NewsAnalysisResult 提取精簡摘要 ──
  const rss = rssRaw ? summariseRss(rssRaw) : null;

  if (!youtube && !rss) {
    fetchErrors.push('both youtube and rss empty');
  }

  const groundTruth: NewsGroundTruth = {
    symbol,
    name: name || null,
    youtube,
    rss,
    fetchErrors,
  };

  const question: NewsQuestion = {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'news',
    runId,
    date,
    symbol,
    market,
    groundTruth,
    judgmentRulesRef: NEWS_JUDGMENT_RULES,
  };
  if (candidate) {
    question.entryContext = {
      sources: sliceSourcesForAgent(candidate.sources, 'news') as Pick<Candidate['sources'], 'youtube'>,
      sourceCount: candidate.sourceCount,
    };
  }
  return question;
}

// ────────────────────────────────────────────────────────────────────────────
// YouTube analysis 提取（T-1 + T 兩日聯集窗口）
// ────────────────────────────────────────────────────────────────────────────

export interface YouTubeWindow {
  /** 已讀的 analysis 日期清單，例 ['2026-05-21', '2026-05-22'] */
  dates: string[];
  /** T-1 analysis (可能 null) */
  yesterdayAnalysis: DailyAnalysis | null;
  /** T analysis (可能 null) */
  todayAnalysis: DailyAnalysis | null;
  /** video_id → published_at ISO（由 T-1 + T videos.json 合併）*/
  publishedAtMap: Map<string, string>;
  /** mention 必須落入此窗口才計入 */
  startUtcIso: string;
  endUtcIso: string;
}

/** YYYY-MM-DD → 往回一天的 YYYY-MM-DD（Asia/Taipei 對齊）— exported for testing */
export function subDayYmd(date: string): string {
  const t = new Date(`${date}T00:00:00.000Z`).getTime() - 24 * 3600_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 窗口設計（涵蓋「T-1 盤後節目剛介紹、T 日開盤大漲」的 case）：
 *   startUtc = T-1 01:00 UTC = T-1 09:00 CST  → T-1 開盤起
 *   endUtc   = T   16:00 UTC = T+1 00:00 CST  → T 日結束
 *
 * 範圍 = T-1 09:00 CST 到 T+1 00:00 CST，最多 39 小時，
 * 預期 published 在此區間內的 mentions 都算 T 日的「即時消息」。
 *
 * 例：5/21 23:30 CST published（= 5/21 15:30 UTC）落在 [5/21 01:00 UTC, 5/22 16:00 UTC] 內 ✓
 *
 * Exported for testing.
 */
export function computeWindow(date: string): { startUtcIso: string; endUtcIso: string } {
  const yesterday = subDayYmd(date);
  return {
    startUtcIso: `${yesterday}T01:00:00.000Z`,
    endUtcIso: `${date}T16:00:00.000Z`,
  };
}

async function fetchYouTubeWindow(date: string): Promise<YouTubeWindow> {
  const yesterday = subDayYmd(date);
  const { startUtcIso, endUtcIso } = computeWindow(date);

  const [yA, tA, yVids, tVids] = await Promise.all([
    fetchAnalysis(yesterday),
    fetchAnalysis(date),
    fetchVideosForDate(yesterday),
    fetchVideosForDate(date),
  ]);

  const publishedAtMap = new Map<string, string>();
  for (const v of [...yVids, ...tVids]) {
    if (v.video_id && v.published_at) publishedAtMap.set(v.video_id, v.published_at);
  }

  return {
    dates: [yesterday, date],
    yesterdayAnalysis: yA,
    todayAnalysis: tA,
    publishedAtMap,
    startUtcIso,
    endUtcIso,
  };
}

async function fetchAnalysis(date: string): Promise<DailyAnalysis | null> {
  const raw = await fetchJSON(internalUrl(`/api/youtube/analysis/${date}`));
  if (!raw || typeof raw !== 'object') return null;
  const res = raw as { analysis?: DailyAnalysis | null };
  return res.analysis ?? null;
}

async function fetchVideosForDate(date: string): Promise<YouTubeVideo[]> {
  const raw = await fetchJSON(internalUrl(`/api/youtube/videos?date=${date}&strict=1`));
  if (!raw || typeof raw !== 'object') return [];
  const res = raw as { videos?: YouTubeVideo[] };
  return res.videos ?? [];
}

/** Exported for testing — pure function over YouTubeWindow */
export function extractYouTubeMentionsInWindow(
  win: YouTubeWindow,
  symbol: string,
  name: string,
): NewsYouTubeMention {
  const bare = bareTicker(symbol);
  const startMs = new Date(win.startUtcIso).getTime();
  const endMs = new Date(win.endUtcIso).getTime();

  const matchesSymbol = (m: AnalyzedStockMention): boolean => {
    const code = m.matched?.code ?? '';
    const matchedName = m.matched?.name ?? '';
    return code === bare || code === symbol || matchedName === name;
  };

  // 收集 T-1 + T 兩天的所有 matches，標註是否來自 high_consensus
  type WithSource = { m: AnalyzedStockMention; fromHigh: boolean };
  const collected: WithSource[] = [];
  for (const a of [win.yesterdayAnalysis, win.todayAnalysis]) {
    if (!a) continue;
    for (const m of a.high_consensus_stocks ?? []) {
      if (matchesSymbol(m)) collected.push({ m, fromHigh: true });
    }
    for (const m of a.weak_signal_stocks ?? []) {
      if (matchesSymbol(m)) collected.push({ m, fromHigh: false });
    }
  }

  // 過濾：必須有 video_id 且 published_at 落在窗口內
  // （沒有 published_at 的 mention 視為 stale skip，避免把舊資料混進來）
  const inWindow: WithSource[] = collected.filter((x) => {
    const vid = x.m.video_id;
    if (!vid) return false;
    const pubIso = win.publishedAtMap.get(vid);
    if (!pubIso) return false;
    const t = new Date(pubIso).getTime();
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  });

  // dedup by video_id（同片重複出現只算一次，confidence 取最高）
  const byVideo = new Map<string, WithSource>();
  for (const x of inWindow) {
    const vid = x.m.video_id;
    const prev = byVideo.get(vid);
    if (!prev) {
      byVideo.set(vid, x);
    } else {
      // 已有同 video_id：取 confidence 較高那筆；high_consensus 優先
      const prevConf = prev.m.combined_confidence ?? 0;
      const curConf = x.m.combined_confidence ?? 0;
      if (curConf > prevConf || (x.fromHigh && !prev.fromHigh)) {
        byVideo.set(vid, x);
      }
    }
  }
  const uniques = [...byVideo.values()];

  if (uniques.length === 0) {
    return {
      inHighConsensus: false,
      mentionCount: 0,
      combinedConfidence: null,
      sentiment: null,
      videoIds: [],
      contexts: [],
      windowDates: win.dates,
      publishedAtWindow: { startUtc: win.startUtcIso, endUtc: win.endUtcIso },
    };
  }

  // sentiment：多數決
  const sentimentCounts = new Map<string, number>();
  let confidenceSum = 0;
  const videoIds: string[] = [];
  const contexts: string[] = [];
  let anyHighConsensus = false;

  for (const { m, fromHigh } of uniques) {
    sentimentCounts.set(m.sentiment, (sentimentCounts.get(m.sentiment) ?? 0) + 1);
    confidenceSum += m.combined_confidence;
    videoIds.push(m.video_id);
    if (m.context && contexts.length < 5) contexts.push(m.context);
    if (fromHigh) anyHighConsensus = true;
  }
  const sentiment = [...sentimentCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const combinedConfidence = uniques.length > 0 ? confidenceSum / uniques.length : null;

  return {
    inHighConsensus: anyHighConsensus,
    mentionCount: uniques.length,
    combinedConfidence,
    sentiment,
    videoIds,
    contexts,
    windowDates: win.dates,
    publishedAtWindow: { startUtc: win.startUtcIso, endUtc: win.endUtcIso },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// RSS news 摘要
// ────────────────────────────────────────────────────────────────────────────

async function fetchRssNews(symbol: string): Promise<unknown> {
  // /api/news/[ticker] 接受 4-6 digit 純數字 ticker
  const ticker = bareTicker(symbol);
  if (!/^\d{4,6}$/.test(ticker)) return null;
  return fetchJSON(internalUrl(`/api/news/${ticker}`));
}

function summariseRss(raw: unknown): NewsRssSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    hasNews?: boolean;
    aggregateSentiment?: number;
    summary?: string;
    articles?: Array<{
      item: { title: string; source: string; publishedAt: string };
      score: number;
      label: 'positive' | 'negative' | 'neutral';
    }>;
  };
  const articles = r.articles ?? [];
  return {
    hasNews: !!r.hasNews,
    aggregateSentiment: r.aggregateSentiment ?? 0,
    summary: r.summary ?? '',
    recentCount: articles.length,
    articles: articles.slice(0, 5).map((a) => ({
      title: a.item?.title ?? '',
      source: a.item?.source ?? '',
      publishedAt: a.item?.publishedAt ?? '',
      label: a.label,
      score: a.score,
    })),
  };
}
