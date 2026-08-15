import type { CnMediaSource, CnMediaVideo } from './types';

const API = 'https://api.bilibili.com';
const MOBILE_SEARCH = 'https://m.bilibili.com/search';
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36';

export interface BilibiliSearchItem {
  bvid: string;
  title: string;
  duration?: number;
  owner?: { mid: number; name: string };
}

interface BilibiliViewData {
  bvid: string;
  title: string;
  pubdate: number;
  duration: number;
  owner: { mid: number; name: string };
  pages: Array<{ cid: number; duration: number }>;
}

interface BilibiliPlayData {
  dash?: {
    audio?: Array<{ bandwidth: number; baseUrl?: string; base_url?: string }>;
  };
}

interface BilibiliApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

interface BilibiliInitialState {
  search?: {
    searchAllResult?: {
      totalrank?: { result?: BilibiliSearchItem[] };
    };
  };
}

function dateShanghai(epochSeconds: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(epochSeconds * 1_000));
}

function sourceMid(source: CnMediaSource): number {
  const match = source.url.match(/space\.bilibili\.com\/(\d+)/);
  if (!match) throw new Error(`invalid bilibili source URL: ${source.url}`);
  return Number(match[1]);
}

function cleanTitle(title: string): string {
  return title.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

export function parseBilibiliSearchHtml(html: string): BilibiliSearchItem[] {
  const marker = 'window.__INITIAL_STATE__=';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('Bilibili search state unavailable');
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(';(function()', jsonStart);
  if (jsonEnd < 0) throw new Error('Bilibili search state truncated');
  const state = JSON.parse(html.slice(jsonStart, jsonEnd)) as BilibiliInitialState;
  return (state.search?.searchAllResult?.totalrank?.result ?? []).map(item => ({
    ...item,
    title: cleanTitle(item.title),
  }));
}

export function filterBilibiliSearchItems(
  source: CnMediaSource,
  items: BilibiliSearchItem[],
): BilibiliSearchItem[] {
  const mid = sourceMid(source);
  const keywords = source.include_title_keywords ?? [];
  return items.filter(item => item.owner?.mid === mid
    && (keywords.length === 0 || keywords.some(keyword => item.title.toLowerCase().includes(keyword.toLowerCase()))));
}

async function apiJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.bilibili.com/' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Bilibili HTTP ${response.status}`);
  const body = await response.json() as BilibiliApiResponse<T>;
  if (body.code !== 0) throw new Error(`Bilibili API ${body.code}: ${body.message}`);
  return body.data;
}

async function searchItems(source: CnMediaSource): Promise<BilibiliSearchItem[]> {
  const query = source.search_query ?? source.display_name;
  const pages = source.search_pages ?? 3;
  const all: BilibiliSearchItem[] = [];
  const errors: string[] = [];
  for (let page = 1; page <= pages; page += 1) {
    try {
      const params = new URLSearchParams({ keyword: query, order: 'pubdate', page: String(page) });
      const response = await fetch(`${MOBILE_SEARCH}?${params}`, {
        headers: { 'User-Agent': USER_AGENT },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      all.push(...parseBilibiliSearchHtml(await response.text()));
    } catch (error) {
      errors.push(`page ${page}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length === pages) throw new Error(`Bilibili search failed (${errors.join('; ')})`);
  const filtered = filterBilibiliSearchItems(source, all);
  return [...new Map(filtered.map(item => [item.bvid, item])).values()];
}

async function viewVideo(bvid: string): Promise<BilibiliViewData> {
  return apiJson<BilibiliViewData>(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
}

async function audioUrl(view: BilibiliViewData): Promise<string | null> {
  const cid = view.pages[0]?.cid;
  if (!cid) return null;
  const play = await apiJson<BilibiliPlayData>(
    `${API}/x/player/playurl?bvid=${encodeURIComponent(view.bvid)}&cid=${cid}&qn=64&fnval=16&fourk=0`,
  );
  const audio = [...(play.dash?.audio ?? [])].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  return audio?.baseUrl ?? audio?.base_url ?? null;
}

export async function fetchBilibiliVideos(source: CnMediaSource, targetDate: string): Promise<CnMediaVideo[]> {
  const items = await searchItems(source);
  const mid = sourceMid(source);
  const now = new Date().toISOString();
  const videos: CnMediaVideo[] = [];
  for (const item of items) {
    const view = await viewVideo(item.bvid);
    if (view.owner.mid !== mid || dateShanghai(view.pubdate) !== targetDate) continue;
    videos.push({
      video_id: `bilibili-${view.bvid}`,
      source_id: source.source_id,
      platform: 'bilibili',
      title: view.title,
      url: `https://www.bilibili.com/video/${view.bvid}/`,
      media_url: await audioUrl(view),
      published_at: new Date(view.pubdate * 1_000).toISOString(),
      program_date: targetDate,
      duration_sec: view.duration || item.duration || null,
      analysts: source.default_analysts.length ? source.default_analysts : [view.owner.name],
      source_tier: source.source_tier,
      discovered_at: now,
      last_seen_at: now,
    });
  }
  return videos;
}
