/**
 * GET /api/youtube/video-breakdown?date=YYYY-MM-DD
 *
 * 每支影片把提到的股票按「證據來源」拆三欄：
 *   speech       = 只有口述抓到
 *   slide        = 只在簡報畫面（OCR）抓到 ← 畫面理解的獨家貢獻（老師沒唸出來）
 *   speech+slide = 口述 + 畫面都有
 *
 * 讓使用者一眼看出「加了畫面 OCR 多補到多少純語音漏掉的股票」。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { loadDailyAnalysis } from '@/lib/youtube/analysisStorage';
import { loadSources, loadVideosForDate } from '@/lib/youtube/videoStorage';
import type { MentionSourceType, StockSentiment } from '@/lib/youtube/analysisStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StockLite { code: string; name: string; sentiment: StockSentiment; recommendation_type?: string }
export interface VideoBreakdown {
  video_id: string;
  source_id: string;
  display_name: string;
  title: string;
  url: string;
  speech: StockLite[];
  slide: StockLite[];
  both: StockLite[];
}
export interface VideoBreakdownResponse {
  date: string;
  hasKeyframeData: boolean;   // 該日有沒有任何 slide/both（畫面資料）
  videos: VideoBreakdown[];
  totals: { speech: number; slide: number; both: number };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayYmdTaipei(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return apiError('date must be YYYY-MM-DD', 400);

  try {
    const analysis = await loadDailyAnalysis(date);
    if (!analysis) return apiOk<VideoBreakdownResponse>({ date, hasKeyframeData: false, videos: [], totals: { speech: 0, slide: 0, both: 0 } });

    const [sources, videos] = await Promise.all([loadSources(), loadVideosForDate(date)]);
    const displayById = new Map(sources.map(s => [s.source_id, s.display_name]));
    const videoById = new Map(videos.map(v => [v.video_id, v]));

    const byVideo = new Map<string, VideoBreakdown>();
    const seen = new Set<string>();  // video_id:code:bucket dedup
    const mentions = [...analysis.high_consensus_stocks, ...analysis.weak_signal_stocks];
    for (const m of mentions) {
      if (!m.matched) continue;
      const st: MentionSourceType = m.source_type ?? 'speech';
      let vb = byVideo.get(m.video_id);
      if (!vb) {
        const vid = videoById.get(m.video_id);
        vb = {
          video_id: m.video_id, source_id: m.source_id,
          display_name: displayById.get(m.source_id) ?? m.source_id,
          title: vid?.title ?? '', url: vid?.url ?? `https://www.youtube.com/watch?v=${m.video_id}`,
          speech: [], slide: [], both: [],
        };
        byVideo.set(m.video_id, vb);
      }
      const bucket = st === 'slide' ? 'slide' : st === 'speech+slide' ? 'both' : 'speech';
      const dedupKey = `${m.video_id}:${m.matched.code}:${bucket}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      vb[bucket].push({ code: m.matched.code, name: m.matched.name, sentiment: m.sentiment, recommendation_type: m.recommendation_type });
    }

    const videoList = [...byVideo.values()].sort((a, b) => (b.slide.length + b.both.length) - (a.slide.length + a.both.length));
    const totals = videoList.reduce(
      (acc, v) => ({ speech: acc.speech + v.speech.length, slide: acc.slide + v.slide.length, both: acc.both + v.both.length }),
      { speech: 0, slide: 0, both: 0 },
    );
    return apiOk<VideoBreakdownResponse>({
      date,
      hasKeyframeData: totals.slide + totals.both > 0,
      videos: videoList,
      totals,
    });
  } catch (err) {
    return apiError(`video-breakdown failed: ${(err as Error).message}`, 500);
  }
}
