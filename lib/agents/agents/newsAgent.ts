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
 */

import { fetchJSON, internalUrl, bareTicker } from './_fetchHelper';
import {
  AGENT_SCHEMA_VERSION,
  NewsGroundTruth,
  NewsQuestion,
  NewsRssSummary,
  NewsYouTubeMention,
} from '@/lib/agents/types';
import type { DailyAnalysis, AnalyzedStockMention } from '@/lib/youtube/analysisStorage';
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

  // ── prefetch 並行 ──
  const [youtubeRaw, rssRaw] = await Promise.all([
    fetchYouTubeAnalysis(date).catch((e) => { fetchErrors.push(`youtube: ${e}`); return null; }),
    fetchRssNews(symbol).catch((e) => { fetchErrors.push(`news: ${e}`); return null; }),
  ]);

  // ── 從 YouTube DailyAnalysis 提取該 symbol 的 mention 摘要 ──
  const youtube = youtubeRaw ? extractYouTubeMention(youtubeRaw, symbol, name) : null;

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
// YouTube analysis 提取
// ────────────────────────────────────────────────────────────────────────────

async function fetchYouTubeAnalysis(date: string): Promise<DailyAnalysis | null> {
  const raw = await fetchJSON(internalUrl(`/api/youtube/analysis/${date}`));
  if (!raw || typeof raw !== 'object') return null;
  const res = raw as { analysis?: DailyAnalysis | null };
  return res.analysis ?? null;
}

function extractYouTubeMention(
  analysis: DailyAnalysis,
  symbol: string,
  name: string,
): NewsYouTubeMention | null {
  const bare = bareTicker(symbol);

  // 從 high_consensus_stocks 與 weak_signal_stocks 各自找
  const matches = (mentions: AnalyzedStockMention[] = []): AnalyzedStockMention[] =>
    mentions.filter((m) => {
      const code = m.matched?.code ?? '';
      const matchedName = m.matched?.name ?? '';
      return code === bare || code === symbol || matchedName === name;
    });

  const highMatches = matches(analysis.high_consensus_stocks);
  const weakMatches = matches(analysis.weak_signal_stocks);
  const allMatches = [...highMatches, ...weakMatches];

  if (allMatches.length === 0) {
    // 沒被任何節目提到
    return {
      inHighConsensus: false,
      mentionCount: 0,
      combinedConfidence: null,
      sentiment: null,
      videoIds: [],
      contexts: [],
    };
  }

  // sentiment：多數決
  const sentimentCounts = new Map<string, number>();
  let confidenceSum = 0;
  const videoIds = new Set<string>();
  const contexts: string[] = [];

  for (const m of allMatches) {
    sentimentCounts.set(m.sentiment, (sentimentCounts.get(m.sentiment) ?? 0) + 1);
    confidenceSum += m.combined_confidence;
    if (m.video_id) videoIds.add(m.video_id);
    if (m.context && contexts.length < 5) contexts.push(m.context);
  }
  const sentiment = [...sentimentCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const combinedConfidence = allMatches.length > 0 ? confidenceSum / allMatches.length : null;

  return {
    inHighConsensus: highMatches.length > 0,
    mentionCount: allMatches.length,
    combinedConfidence,
    sentiment,
    videoIds: [...videoIds],
    contexts,
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
