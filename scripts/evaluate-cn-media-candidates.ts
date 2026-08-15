import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { collectCnStockCandidates, loadCnStockMaster } from '@/lib/cn-media/stockMaster';
import { transcribeCnMediaVideo } from '@/lib/cn-media/transcribe';
import { computeNDayReturns } from '@/lib/youtube/performance';
import type { CnMediaVideo } from '@/lib/cn-media/types';

interface CandidateInput {
  source_id: string;
  display_name: string;
  analyst?: string;
  source_tier?: 'official_media' | 'creator';
  bvid: string;
  date: string;
}

interface ViewData {
  bvid: string;
  title: string;
  pubdate: number;
  duration: number;
  owner: { mid: number; name: string };
  pages: Array<{ cid: number }>;
}

interface PlayData {
  dash?: { audio?: Array<{ bandwidth: number; baseUrl?: string; base_url?: string }> };
  durl?: Array<{ url?: string }>;
}

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36';

async function bilibiliApi<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.bilibili.com/' },
  });
  if (!response.ok) throw new Error(`Bilibili HTTP ${response.status}`);
  const body = await response.json() as ApiResponse<T>;
  if (body.code !== 0) throw new Error(`Bilibili API ${body.code}: ${body.message}`);
  return body.data;
}

async function buildVideo(input: CandidateInput): Promise<CnMediaVideo> {
  const view = await bilibiliApi<ViewData>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(input.bvid)}`,
  );
  const cid = view.pages[0]?.cid;
  if (!cid) throw new Error(`${input.bvid} missing cid`);
  const play = await bilibiliApi<PlayData>(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(input.bvid)}&cid=${cid}&qn=64&fnval=16&fourk=0`,
  );
  const audio = [...(play.dash?.audio ?? [])].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  const mediaUrl = audio?.baseUrl ?? audio?.base_url ?? play.durl?.[0]?.url;
  if (!mediaUrl) throw new Error(`${input.bvid} missing audio`);
  const now = new Date().toISOString();
  return {
    video_id: `bilibili-${view.bvid}`,
    source_id: input.source_id,
    platform: 'bilibili',
    title: view.title,
    url: `https://www.bilibili.com/video/${view.bvid}/`,
    media_url: mediaUrl,
    published_at: new Date(view.pubdate * 1_000).toISOString(),
    program_date: input.date,
    duration_sec: view.duration,
    analysts: [input.analyst ?? input.display_name],
    source_tier: input.source_tier ?? 'creator',
    discovered_at: now,
    last_seen_at: now,
  };
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    throw new Error('usage: npx tsx scripts/evaluate-cn-media-candidates.ts INPUT.json OUTPUT.json');
  }
  const inputs = JSON.parse(await fs.readFile(path.resolve(inputPath), 'utf-8')) as CandidateInput[];
  const master = await loadCnStockMaster();
  const results: unknown[] = [];
  for (const input of inputs) {
    process.stderr.write(`[candidate] ${input.date} ${input.display_name} ${input.bvid}\n`);
    try {
      const video = await buildVideo(input);
      const transcript = await transcribeCnMediaVideo(video);
      const candidates = collectCnStockCandidates([video.title, transcript.text], master);
      const stocks = await Promise.all(candidates.map(async stock => {
        const candles = await loadLocalCandles(stock.symbol, 'CN');
        return {
          code: stock.code,
          symbol: stock.symbol,
          name: stock.name,
          performance: computeNDayReturns(candles ?? [], input.date),
        };
      }));
      results.push({ input, video, transcript, stocks });
    } catch (error) {
      results.push({ input, error: error instanceof Error ? error.message : String(error) });
    }
    await fs.writeFile(path.resolve(outputPath), JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
