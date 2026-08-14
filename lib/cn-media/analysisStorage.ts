import type { FactorScores, RecommendationType, StockRating, StockSentiment } from '@/lib/youtube/analysisStorage';
import { loadCnMediaAnalysis } from './storage';
import type { CnMediaFactorEvidence, CnStockMatch } from './types';

export interface CnMediaMention {
  raw_query: string;
  matched: CnStockMatch | null;
  llm_confidence: number;
  combined_confidence: number;
  sentiment: StockSentiment;
  recommendation_type: RecommendationType;
  context: string;
  reason: string;
  source_id: string;
  video_id: string;
  analysts: string[];
  mention_time?: number;
}
export interface CnMediaStockScoring {
  stock_code: string;
  stock_name: string;
  factor_scores: FactorScores;
  factor_evidence: Record<keyof Omit<FactorScores, 'chip'>, CnMediaFactorEvidence>;
  composite_score: number;
  rating: StockRating;
  action: string;
  risk_flags: string[];
  reasoning: string;
}

export interface CnMediaVideoSummary {
  video_id: string;
  source_id: string;
  source_name: string;
  title: string;
  url: string;
  analysts: string[];
  summary: string;
  market_stance: 'bullish' | 'bearish' | 'neutral' | 'mixed';
  key_stocks: Array<{ code: string; name: string }>;
  watch_priority: 'must_watch' | 'skim' | 'skip';
  watch_reason: string;
  duration_sec: number | null;
}

export interface CnMediaDailyAnalysis {
  date: string;
  generated_at: string;
  market_view: string;
  source_concentration_note: string;
  bullish_consensus: string[];
  bearish_consensus: string[];
  high_consensus_stocks: CnMediaMention[];
  weak_signal_stocks: CnMediaMention[];
  stock_scoring: CnMediaStockScoring[];
  video_summaries: CnMediaVideoSummary[];
  stats: {
    videos_analyzed: number;
    unique_stocks_total: number;
    high_consensus_count: number;
    weak_signal_count: number;
    rating_distribution: { A: number; B: number; C: number; D: number };
  };
}

export async function loadCnMediaDailyAnalysis(date: string): Promise<CnMediaDailyAnalysis | null> {
  return await loadCnMediaAnalysis<CnMediaDailyAnalysis>(date);
}

export function aggregateCnMediaMentions(analysis: CnMediaDailyAnalysis) {
  const scoring = new Map(analysis.stock_scoring.map(item => [item.stock_code, item]));
  const stocks = new Map<string, {
    code: string; name: string; mentions: CnMediaMention[]; bullish: number; bearish: number;
    scoring: CnMediaStockScoring | null;
  }>();
  for (const mention of [...analysis.high_consensus_stocks, ...analysis.weak_signal_stocks]) {
    if (!mention.matched || mention.combined_confidence < 0.6) continue;
    const current = stocks.get(mention.matched.code) ?? {
      code: mention.matched.code,
      name: mention.matched.name,
      mentions: [], bullish: 0, bearish: 0,
      scoring: scoring.get(mention.matched.code) ?? null,
    };
    current.mentions.push(mention);
    if (mention.sentiment === 'bullish') current.bullish++;
    if (mention.sentiment === 'bearish' || mention.sentiment === 'risk_warning') current.bearish++;
    stocks.set(current.code, current);
  }
  const ratingOrder: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };
  return [...stocks.values()].sort((a, b) =>
    (ratingOrder[b.scoring?.rating ?? ''] ?? 0) - (ratingOrder[a.scoring?.rating ?? ''] ?? 0)
    || b.mentions.length - a.mentions.length,
  );
}
