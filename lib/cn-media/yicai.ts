import type { CnMediaSource, CnMediaVideo } from './types';

interface YicaiListItem {
  NewsID?: number;
  NewsTitle?: string;
  CreateDate?: string;
  EntityPublishDate?: string;
  NewsLengtho?: number;
  NewsLength?: string;
  ShareUrl?: string;
  VideoUrl?: string;
  url?: string;
}

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';

/** 從 `var firstlist = [...]` 擷取 JSON；不用脆弱的 HTML DOM selector。 */
export function parseYicaiFirstList(html: string): YicaiListItem[] {
  const marker = 'var firstlist = ';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('firstlist marker not found');
  const jsonStart = start + marker.length;
  const end = html.indexOf(';</script>', jsonStart);
  if (end < 0) throw new Error('firstlist terminator not found');
  const parsed = JSON.parse(html.slice(jsonStart, end)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('firstlist is not an array');
  return parsed as YicaiListItem[];
}

export function parseYicaiDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  const h = raw.match(/(\d+)\s*h/i)?.[1];
  const minute = raw.match(/(\d+)\s*'/)?.[1];
  const second = raw.match(/(\d+)\s*''/)?.[1];
  const total = Number(h ?? 0) * 3600 + Number(minute ?? 0) * 60 + Number(second ?? 0);
  return total > 0 ? total : null;
}

function shanghaiIso(local: string): string {
  // 第一財經回傳無時區的上海時間。顯式補 +08:00，避免伺服器時區改變日期。
  return new Date(`${local.replace(' ', 'T')}+08:00`).toISOString();
}

export function ymdShanghai(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

export function mapYicaiItems(
  source: CnMediaSource,
  items: YicaiListItem[],
  targetDate: string,
  now = new Date(),
): CnMediaVideo[] {
  const seen = new Set<string>();
  const out: CnMediaVideo[] = [];
  for (const item of items) {
    if (!item.NewsID || !item.NewsTitle) continue;
    const localDate = item.EntityPublishDate ?? item.CreateDate;
    if (!localDate) continue;
    const publishedAt = shanghaiIso(localDate);
    if (ymdShanghai(publishedAt) !== targetDate) continue;
    const videoId = `yicai-${item.NewsID}`;
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    out.push({
      video_id: videoId,
      source_id: source.source_id,
      platform: 'yicai',
      title: item.NewsTitle,
      url: item.ShareUrl || `https://www.yicai.com${item.url || `/video/${item.NewsID}.html`}`,
      media_url: item.VideoUrl || null,
      published_at: publishedAt,
      program_date: targetDate,
      duration_sec: typeof item.NewsLengtho === 'number' && item.NewsLengtho > 0
        ? item.NewsLengtho
        : parseYicaiDuration(item.NewsLength),
      analysts: [...source.default_analysts],
      source_tier: source.source_tier,
      discovered_at: now.toISOString(),
      last_seen_at: now.toISOString(),
    });
  }
  return out;
}

export async function fetchYicaiVideos(
  source: CnMediaSource,
  targetDate: string,
): Promise<CnMediaVideo[]> {
  const response = await fetch(source.url, {
    headers: { 'user-agent': DESKTOP_UA, accept: 'text/html,application/xhtml+xml' },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Yicai HTTP ${response.status}`);
  const html = await response.text();
  return mapYicaiItems(source, parseYicaiFirstList(html), targetDate);
}
