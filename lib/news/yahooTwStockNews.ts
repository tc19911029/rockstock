import type { NewsItem } from './types';

const YAHOO_TW_STOCK = 'https://tw.stock.yahoo.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

function publishedAtFromSnippet(snippet: string): string | null {
  const match = snippet.match(/日\s*期[：:]\s*(\d{4})年(\d{2})月(\d{2})日/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`;
}

function titleHash(title: string): string {
  // This is only a stable local dedupe key; the shared aggregator still performs
  // its normal cross-source SHA-256 deduplication afterwards.
  let hash = 2166136261;
  for (const char of title.toLowerCase().replace(/[\s\W]+/g, '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `ytw-${(hash >>> 0).toString(16)}`;
}

/** Parse the server-rendered Yahoo Taiwan stock news cards without relying on client JS. */
export function parseYahooTwStockNewsHtml(html: string): NewsItem[] {
  const items: NewsItem[] = [];
  const seenUrls = new Set<string>();
  const decodeJsonString = (quoted: string): string | null => {
    try {
      const value = JSON.parse(quoted);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };

  // Yahoo embeds the same cards as escaped story objects. Prefer these because each title,
  // URL and summary is an explicit tuple; DOM card markup has unrelated links between cards.
  const storyPattern = /"summary":("(?:\\.|[^"\\])*")[\s\S]{0,2500}?"url":("(?:\\.|[^"\\])*")[\s\S]{0,5000}?"title":("(?:\\.|[^"\\])*")/g;
  let storyMatch: RegExpExecArray | null;
  while ((storyMatch = storyPattern.exec(html)) !== null) {
    const snippet = decodeJsonString(storyMatch[1]);
    const url = decodeJsonString(storyMatch[2]);
    const title = decodeJsonString(storyMatch[3]);
    const publishedAt = snippet ? publishedAtFromSnippet(snippet) : null;
    if (!snippet || !url || !title || !publishedAt || !url.startsWith(`${YAHOO_TW_STOCK}/news/`) || seenUrls.has(url)) continue;
    seenUrls.add(url);
    items.push({ title, url, source: 'Yahoo 股市（中央社公告）', publishedAt, snippet, titleHash: titleHash(title) });
  }

  if (items.length > 0) return items;

  // Small fixture / markup-only fallback.
  const cardPattern = /<h3\b[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>\s*<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;

  while ((match = cardPattern.exec(html)) !== null) {
    const title = decodeHtml(match[2]);
    const snippet = decodeHtml(match[3]);
    const publishedAt = publishedAtFromSnippet(snippet);
    if (!title || !publishedAt) continue;

    const url = match[1].startsWith('/') ? `${YAHOO_TW_STOCK}${match[1]}` : decodeHtml(match[1]);
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    items.push({
      title,
      url,
      source: 'Yahoo 股市（中央社公告）',
      publishedAt,
      snippet,
      titleHash: titleHash(title),
    });
  }

  return items;
}

/** Yahoo Taiwan is materially faster than the next-day MOPS OpenAPI batch for attention-stock EPS. */
export async function fetchYahooTwStockNews(ticker: string): Promise<NewsItem[]> {
  const stockId = ticker.replace(/\.(TW|TWO)$/i, '');
  if (!/^\d{4,6}$/.test(stockId)) return [];
  const suffixHint = ticker.match(/\.(TW|TWO)$/i)?.[1]?.toUpperCase();
  const suffixes = suffixHint ? [suffixHint] : ['TW', 'TWO'];
  let lastStatus: number | null = null;

  for (const suffix of suffixes) {
    const response = await fetch(`${YAHOO_TW_STOCK}/quote/${encodeURIComponent(stockId)}.${suffix}/news`, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    lastStatus = response.status;
    if (!response.ok) continue;
    const items = parseYahooTwStockNewsHtml(await response.text());
    if (items.length > 0) return items;
  }

  if (lastStatus && lastStatus >= 400) throw new Error(`Yahoo TW news HTTP ${lastStatus}`);
  return [];
}
