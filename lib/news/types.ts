/**
 * News aggregation pipeline — shared type contracts.
 * NEWS-01 through NEWS-06.
 */

/** Single news article after normalization */
export interface NewsItem {
  title: string;
  url: string;
  source: string;         // Feed name, e.g. "Yahoo Finance", "工商時報"
  publishedAt: string;    // ISO 8601 UTC
  snippet: string;        // First 200 chars of description, cleaned of HTML
  titleHash: string;      // SHA-256 of normalized title for dedup (NEWS-06)
}

/** Result of Claude sentiment analysis on a single article */
export interface ArticleSentiment {
  item: NewsItem;
  score: number;          // -1.0 (very negative) to +1.0 (very positive)
  label: 'positive' | 'negative' | 'neutral';
  rationale: string;      // One-sentence Claude explanation
}

/** Full news analysis result for a ticker */
export interface NewsAnalysisResult {
  ticker: string;
  fetchedAt: string;
  articles: ArticleSentiment[];  // Up to 5, deduplicated, ≤3 days old
  aggregateSentiment: number;    // Weighted average of article scores
  summary: string;               // 1-2 sentence aggregate summary from Claude
  hasNews: boolean;              // false → show "新聞資料不足" (NEWS-05)
}
