/**
 * GET /api/youtube/teacher-leaderboard?days=30|60|90&end=YYYY-MM-DD
 *
 * 老師/節目推薦績效排行榜。事件讀 recommendations/{date}.json（凍結基準價），
 * 前瞻報酬從 L1 K 線即時 derive（loadLocalCandles 有快取；symbol 在 request 內 memo）。
 *
 * 排序由前端做（同 /api/backtest/leaderboard 慣例，server 不吃 sort 參數）。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { loadRecoEventsInRange } from '@/lib/youtube/recoStorage';
import { computeEventReturns } from '@/lib/youtube/recoPerformance';
import { buildExtremes, buildProgramRows, buildStockAggRows, buildTeacherRows } from '@/lib/youtube/recoLeaderboard';
import { loadSources } from '@/lib/youtube/videoStorage';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { fetchTwOfficialIndustryRoster } from '@/lib/datasource/TWOfficialIndustry';
import type { BaselineCandle } from '@/lib/youtube/recoBaseline';
import type { RecoEventWithReturns, TeacherLeaderboardResponse } from '@/lib/youtube/recoTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_DAYS = new Set([30, 60, 90]);
/** 正式榜門檻：scored 樣本 ≥ 此數才進正式榜，否則潛力觀察榜（2026-06-13 使用者定 10） */
const MIN_SCORED = 10;
/** 各新榜取前幾名 */
const TOP_N = 8;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const days = Number(url.searchParams.get('days') ?? 30);
  // 時光機：站在 asOf 當天回看，只用 date<asOf 的事件、報酬只算到 asOf（無前視偏誤）
  const asOf = url.searchParams.get('asOf') || null;
  const end = asOf || url.searchParams.get('end') || todayYmdTaipei(new Date());
  if (!ALLOWED_DAYS.has(days)) return apiError('days must be 30|60|90', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return apiError('end must be YYYY-MM-DD', 400);
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return apiError('asOf must be YYYY-MM-DD', 400);

  try {
    const [allFiles, sources, officialRoster] = await Promise.all([
      loadRecoEventsInRange(end, days),
      loadSources(),
      fetchTwOfficialIndustryRoster().catch(() => []),
    ]);
    // asOf 模式：去掉 asOf 當天（含）之後的分析 — 那天晚上才會產出，當下看不到
    const files = asOf ? allFiles.filter(f => f.date < asOf) : allFiles;
    const displayById = new Map(sources.map(s => [s.source_id, s.display_name]));
    const resolveDisplayName = (id: string) => displayById.get(id) ?? id;
    const industryByCode = new Map(officialRoster.map((stock) => [stock.code, stock.industry]));
    const resolveIndustries = (code: string): string[] => {
      const industry = industryByCode.get(code);
      return industry ? [industry] : [];
    };

    // request 內 memo：同 symbol 只載一次；^TWII 載一次
    const candleCache = new Map<string, BaselineCandle[] | null>();
    const getCandles = async (symbol: string): Promise<BaselineCandle[] | null> => {
      if (candleCache.has(symbol)) return candleCache.get(symbol)!;
      const c = await loadLocalCandles(symbol, 'TW');
      candleCache.set(symbol, c);
      return c;
    };
    const indexCandles = await getCandles('^TWII');

    const events: RecoEventWithReturns[] = [];
    const uniqueVideos = new Set<string>();
    const uniquePrograms = new Set<string>();
    const namedTeachers = new Set<string>();
    const visibleOpts = asOf ? { visibleUntil: asOf } : undefined;
    for (const f of files) {
      for (const ev of f.events) {
        const stockCandles = ev.baseline.status === 'filled' ? await getCandles(ev.symbol) : null;
        events.push({ ...ev, returns: computeEventReturns(ev, stockCandles, indexCandles, visibleOpts) });
        if (ev.teacher_kind === 'person') namedTeachers.add(ev.teacher);
        for (const v of ev.videos) { uniqueVideos.add(v.video_id); uniquePrograms.add(v.source_id); }
      }
    }

    const eventDates = new Set(files.map(f => f.date)).size;
    const startDate = files.length > 0 ? files[0].date : end;

    // 按股票聚合一次，共識股 / 最多節目 / 共識地雷股 都從這份切
    const stockRows = buildStockAggRows(events, resolveDisplayName, resolveIndustries);
    const consensusStocks = [...stockRows]
      .sort((a, b) => b.teacherCount - a.teacherCount || b.totalMentions - a.totalMentions)
      .slice(0, TOP_N);
    const topByProgram = [...stockRows]
      .sort((a, b) => b.programCount - a.programCount || b.totalMentions - a.totalMentions)
      .slice(0, TOP_N);
    const worstStocks = stockRows
      .filter(s => s.teacherCount >= 2 && s.avgHold != null)
      .sort((a, b) => (a.avgHold ?? 0) - (b.avgHold ?? 0))
      .slice(0, TOP_N);

    const gainers = buildExtremes(events, resolveDisplayName, resolveIndustries, 'gain', TOP_N);
    const losers = buildExtremes(events, resolveDisplayName, resolveIndustries, 'loss', TOP_N);

    const response: TeacherLeaderboardResponse = {
      window: { start: startDate, end, days, eventDates, ...(asOf ? { asOf } : {}) },
      coverage: {
        totalEvents: events.length,
        scoredEvents: events.filter(e => e.cohort === 'scored' && !e.conflict && e.baseline.status === 'filled').length,
        uniqueVideos: uniqueVideos.size,
        uniquePrograms: uniquePrograms.size,
        namedTeachers: namedTeachers.size,
      },
      entryBaseline: 'next-open',
      generatedAt: new Date().toISOString(),
      teachers: buildTeacherRows(events, resolveDisplayName),
      programs: buildProgramRows(events, resolveDisplayName),
      worstStocks,
      consensusStocks,
      topByProgram,
      gainers,
      losers,
      meta: {
        minScored: MIN_SCORED,
        survivorshipNote:
          '進場價＝提及隔日開盤；一字鎖死(no_fill)/無K線(no_data)不計入勝率但列入覆蓋統計；D+60 未走完的事件僅計入已到期的橫斷。',
      },
    };
    return apiOk(response);
  } catch (err) {
    return apiError(`teacher-leaderboard failed: ${(err as Error).message}`, 500);
  }
}
