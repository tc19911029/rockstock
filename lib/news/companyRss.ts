import { createHash } from 'node:crypto';
import { fetchTextWithCurlFallback } from '@/lib/datasource/curlFetch';
import type { NewsItem } from './types';

function tag(xml: string, name: string): string {
  return (xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
}

/** Indexed headlines only: require company relevance and an actual publication date. */
export function parseCompanyNewsRss(xml: string, name: string, start: number, end: number): NewsItem[] {
  const seen = new Set<string>();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap(match => {
    const title = tag(match[1], 'title');
    const url = tag(match[1], 'link');
    const time = Date.parse(tag(match[1], 'pubDate'));
    const titleHash = createHash('sha256').update(title.normalize('NFKC').replace(/\s+/g, '')).digest('hex');
    if (!name.trim() || !title.includes(name.trim()) || !/^https?:\/\//.test(url)
      || !Number.isFinite(time) || time < start || time >= end || seen.has(titleHash)) return [];
    seen.add(titleHash);
    return [{ title, url, publishedAt: new Date(time).toISOString(), source: tag(match[1], 'source') || 'Google News', snippet: '', titleHash }];
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 5);
}

export async function fetchCompanyNews(name: string, market: 'TW' | 'CN', end = Date.now() + 1): Promise<NewsItem[]> {
  if (!name.trim()) return [];
  const start = end - 3 * 86400_000;
  const locale = market === 'CN' ? 'zh-CN' : 'zh-TW';
  const url = 'https://news.google.com/rss/search?' + new URLSearchParams({
    q: `"${name}" when:3d`, hl: locale, gl: market, ceid: `${market}:${locale === 'zh-CN' ? 'zh-Hans' : 'zh-Hant'}`,
  });
  const { text } = await fetchTextWithCurlFallback(url, { proxyFirst: true, timeoutMs: 8000 });
  return parseCompanyNewsRss(text, name, start, end);
}

/** Sentiment responses wrap each article in `item`; older payloads were flat. */
export function newsArticleTitles(articles: Array<Record<string, unknown>>): string[] {
  return articles.map(article => {
    const item = article.item && typeof article.item === 'object' ? article.item as Record<string, unknown> : article;
    return typeof item.title === 'string' ? item.title.trim() : '';
  }).filter(Boolean);
}
