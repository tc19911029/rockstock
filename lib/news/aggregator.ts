/**
 * News aggregator — fetches RSS feeds, filters by ticker relevance,
 * deduplicates by title hash, and applies 3-day freshness filter.
 * Uses native fetch + minimal XML parser (no rss-parser dependency).
 * NEWS-01, NEWS-02, NEWS-05, NEWS-06.
 */
import { createHash } from 'crypto';
import type { NewsItem } from './types';

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/** RSS feed definitions. Yahoo Finance is per-ticker; others are generic. */
const GENERIC_FEEDS = [
  { name: '工商時報', url: 'https://ctee.com.tw/feed' },
  { name: '自由財經', url: 'https://news.ltn.com.tw/rss/business.xml' },
  { name: 'Focus Taiwan', url: 'https://focustaiwan.tw/rss/business' },
];

interface RssEntry {
  title: string;
  link: string;
  pubDate: string;
  description: string;
}

/** Extract text content from an XML tag (handles CDATA and plain text) */
function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

/** Minimal RSS/Atom XML parser — extracts title, link, pubDate, description */
function parseRssXml(xml: string): RssEntry[] {
  const itemRe = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  const entries: RssEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    let link = extractTag(block, 'link');
    if (!link) {
      const hrefMatch = block.match(/<link[^>]+href="([^"]+)"/i);
      if (hrefMatch) link = hrefMatch[1];
    }
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated');
    const description = extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content');
    if (title) entries.push({ title, link, pubDate, description });
  }
  return entries;
}

/** Strip HTML tags and truncate */
function cleanSnippet(raw: string, maxLen = 200): string {
  return raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/** SHA-256 of normalized title for deduplication (NEWS-06) */
function titleHash(title: string): string {
  const normalized = title.toLowerCase().replace(/[\s\W]+/g, '');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** Check if an article is relevant to the given ticker or company name */
function isRelevant(text: string, ticker: string, companyName?: string): boolean {
  const t = text.toLowerCase();
  if (t.includes(ticker.toLowerCase())) return true;
  if (companyName && t.includes(companyName.toLowerCase())) return true;
  return false;
}

/** Fetch a single RSS feed and return raw entries */
async function fetchFeed(url: string): Promise<RssEntry[]> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssXml(xml);
  } catch {
    return [];
  }
}

/** Convert RssEntry to NewsItem */
function toNewsItem(entry: RssEntry, sourceName: string): NewsItem {
  const pubMs = entry.pubDate ? new Date(entry.pubDate).getTime() : 0;
  const publishedAt = pubMs > 0 ? new Date(pubMs).toISOString() : new Date().toISOString();
  return {
    title: entry.title,
    url: entry.link,
    source: sourceName,
    publishedAt,
    snippet: cleanSnippet(entry.description),
    titleHash: titleHash(entry.title),
  };
}

/**
 * Aggregate recent, deduplicated news for a ticker.
 * @param ticker  4-6 digit Taiwan stock code
 * @param companyName  Chinese company name for generic feed filtering (e.g. "台積電")
 */
export async function aggregateNews(ticker: string, companyName?: string): Promise<NewsItem[]> {
  const cutoff = Date.now() - THREE_DAYS_MS;
  const yahooUrl = `https://finance.yahoo.com/rss/headline?s=${encodeURIComponent(ticker)}.TW`;

  // Fetch all feeds in parallel
  const [yahooEntries, ...genericEntrySets] = await Promise.all([
    fetchFeed(yahooUrl),
    ...GENERIC_FEEDS.map((f) => fetchFeed(f.url)),
  ]);

  // Yahoo items are always ticker-relevant
  const yahooItems = yahooEntries.map((e) => toNewsItem(e, 'Yahoo Finance'));

  // Generic feeds need relevance filtering by ticker or company name
  const genericItems = GENERIC_FEEDS.flatMap((feed, i) =>
    (genericEntrySets[i] ?? [])
      .filter((e) => isRelevant(`${e.title} ${e.description}`, ticker, companyName))
      .map((e) => toNewsItem(e, feed.name))
  );

  const allItems = [...yahooItems, ...genericItems];

  // Apply 3-day freshness filter (NEWS-02)
  const fresh = allItems.filter((item) => {
    const t = new Date(item.publishedAt).getTime();
    return t > 0 && t >= cutoff;
  });

  // Deduplicate by title hash (NEWS-06)
  const seen = new Set<string>();
  const deduped: NewsItem[] = [];
  for (const item of fresh) {
    if (item.title && !seen.has(item.titleHash)) {
      seen.add(item.titleHash);
      deduped.push(item);
    }
  }

  // Sort newest first, cap at 5
  return deduped
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, 5);
}
