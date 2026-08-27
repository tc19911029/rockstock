/**
 * GET /api/youtube/teacher-events?teacher=朱家泓&days=90&end=YYYY-MM-DD
 *
 * 單一老師（或 `節目:{source_id}` fallback）的逐筆推薦事件 drill-down，含即時報酬。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { loadRecoEventsInRange } from '@/lib/youtube/recoStorage';
import { computeEventReturns, evalTargetStop, indexReturnBetween, type TargetStopEval } from '@/lib/youtube/recoPerformance';
import { loadSources, loadVideosForDate } from '@/lib/youtube/videoStorage';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { buildOfficialIndustryPeerMap, fetchTwOfficialIndustryRoster } from '@/lib/datasource/TWOfficialIndustry';
import type { BaselineCandle } from '@/lib/youtube/recoBaseline';
import type { RecoEventWithReturns } from '@/lib/youtube/recoTypes';

/** 相對族群報酬：個股「持有至今」vs 同官方產業成分股同期平均 */
export interface SectorExcess {
  themes: string[];
  peerAvg: number | null;  // 同題材成分股同期平均報酬 %
  excess: number | null;   // holdReturn − peerAvg；正 = 贏過同族群
  peerCount: number;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface TeacherEventsResponse {
  teacher: string;
  window: { start: string; end: string; days: number };
  events: Array<RecoEventWithReturns & {
    video_titles: Record<string, string>;  // video_id → title（前端連結用）
    display_names: Record<string, string>; // source_id → display_name
    targetStop: TargetStopEval | null;     // 目標價/停損觸發（事件有給價位才非 null）
    sector: SectorExcess | null;           // 相對族群報酬（股票屬某題材才非 null）
  }>;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const teacher = url.searchParams.get('teacher');
  const days = Number(url.searchParams.get('days') ?? 90);
  const end = url.searchParams.get('end') || todayYmdTaipei(new Date());
  if (!teacher) return apiError('teacher is required', 400);
  if (!Number.isFinite(days) || days < 1 || days > 365) return apiError('days must be 1-365', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return apiError('end must be YYYY-MM-DD', 400);

  try {
    const [files, sources, officialRoster] = await Promise.all([
      loadRecoEventsInRange(end, days),
      loadSources(),
      fetchTwOfficialIndustryRoster().catch(() => []),
    ]);
    const displayById = new Map(sources.map(s => [s.source_id, s.display_name]));
    const industryByCode = new Map(officialRoster.map((stock) => [stock.code, stock.industry]));
    const peersByCode = buildOfficialIndustryPeerMap(officialRoster);

    const candleCache = new Map<string, BaselineCandle[] | null>();
    const getCandles = async (symbol: string): Promise<BaselineCandle[] | null> => {
      if (candleCache.has(symbol)) return candleCache.get(symbol)!;
      const c = await loadLocalCandles(symbol, 'TW');
      candleCache.set(symbol, c);
      return c;
    };
    const indexCandles = await getCandles('^TWII');

    const matched = files.flatMap(f => f.events.filter(e => e.teacher === teacher));
    // 影片標題：只載有事件的日期的 videos 檔
    const dates = [...new Set(matched.map(e => e.date))];
    const titleByVideo = new Map<string, string>();
    for (const d of dates) {
      for (const v of await loadVideosForDate(d)) titleByVideo.set(v.video_id, v.title);
    }

    // 同題材成分股 .TW/.TWO 自動試後綴載 K 線（memo）
    const getCandlesAnySuffix = async (code: string): Promise<BaselineCandle[] | null> => {
      let c = await getCandles(`${code}.TW`);
      if (!c || c.length === 0) c = await getCandles(`${code}.TWO`);
      return c && c.length > 0 ? c : null;
    };

    const events = [] as TeacherEventsResponse['events'];
    for (const ev of [...matched].sort((a, b) => b.date.localeCompare(a.date))) {
      const stockCandles = ev.baseline.status === 'filled' ? await getCandles(ev.symbol) : null;
      const returns = computeEventReturns(ev, stockCandles, indexCandles);
      const videoTitles: Record<string, string> = {};
      const displayNames: Record<string, string> = {};
      for (const v of ev.videos) {
        videoTitles[v.video_id] = titleByVideo.get(v.video_id) ?? '';
        displayNames[v.source_id] = displayById.get(v.source_id) ?? v.source_id;
      }

      // 相對族群：個股持有至今 vs 同官方產業成分股同期平均
      let sector: SectorExcess | null = null;
      const industry = industryByCode.get(ev.stock_code);
      const themes = industry ? [industry] : [];
      if (themes.length > 0 && returns?.holdReturn != null && ev.baseline.base_date && returns.lastTrackedDate) {
        const peerRets: number[] = [];
        for (const peer of peersByCode.get(ev.stock_code) ?? []) {
          const pc = await getCandlesAnySuffix(peer);
          if (!pc) continue;
          const r = indexReturnBetween(pc, ev.baseline.base_date, returns.lastTrackedDate);
          if (r != null) peerRets.push(r);
        }
        const peerAvg = peerRets.length > 0 ? +(peerRets.reduce((a, b) => a + b, 0) / peerRets.length).toFixed(2) : null;
        sector = {
          themes,
          peerAvg,
          excess: peerAvg != null ? +(returns.holdReturn - peerAvg).toFixed(2) : null,
          peerCount: peerRets.length,
        };
      }

      events.push({
        ...ev,
        returns,
        targetStop: evalTargetStop(ev.baseline, stockCandles, ev.target_price, ev.stop_loss),
        sector,
        video_titles: videoTitles,
        display_names: displayNames,
      });
    }

    const start = files.length > 0 ? files[0].date : end;
    return apiOk<TeacherEventsResponse>({ teacher, window: { start, end, days }, events });
  } catch (err) {
    return apiError(`teacher-events failed: ${(err as Error).message}`, 500);
  }
}
