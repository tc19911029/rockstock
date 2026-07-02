/**
 * GET /api/youtube/teacher-walkforward?asOf=T&topK=3&selectBy=d5&minSample=5
 *
 * 時光機跟單回測（walk-forward，防前視偏誤）：
 *   1. 訓練：站在 asOf 當天，只用 date<asOf 的事件、報酬 clamp 到 asOf（不偷看未來）
 *      → 排出「截至 asOf、selectBy 平均報酬最高」的 top-K 老師
 *   2. 跟單：從 asOf 起，這 top-K 老師「之後的新推薦」每筆隔日開盤模擬買進
 *      → 算持有至今報酬 + 已走完 D1/D5 + vs 大盤超額
 *   3. 基準線：同期「全部老師推薦都買」對照，看篩選有沒有加分
 *
 * 科學性保證：選老師時 computeEventReturns 傳 visibleUntil=asOf，碰不到 asOf 之後的 K 棒。
 * 跟單事件的報酬則是 asOf 之後的真實未來（合法 out-of-sample）。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { loadRecoEventsInRange } from '@/lib/youtube/recoStorage';
import { computeEventReturns, indexReturnBetween } from '@/lib/youtube/recoPerformance';
import { buildTeacherRows } from '@/lib/youtube/recoLeaderboard';
import { selStats } from '@/lib/backtest/unifiedLeaderboard';
import { loadSources } from '@/lib/youtube/videoStorage';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import type { BaselineCandle } from '@/lib/youtube/recoBaseline';
import type { RecoEventWithReturns } from '@/lib/youtube/recoTypes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SelectBy = 'd1' | 'd5' | 'd20';
const ALLOWED_SELECT = new Set<SelectBy>(['d1', 'd5', 'd20']);

interface FollowEvent {
  date: string;
  teacher: string;
  stock_code: string;
  stock_name: string;
  recommendation_type: string;
  entry_open: number | null;
  hold: number | null;       // 持有至今報酬 %
  holdExcess: number | null; // vs 大盤
  d1: number | null;
  d5: number | null;
  isOpen: boolean;           // D5 還沒走完
}

const avg = (xs: Array<number | null | undefined>): number | null => {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const asOf = url.searchParams.get('asOf');
  const topK = Math.max(1, Math.min(10, Number(url.searchParams.get('topK') ?? 3)));
  const selectBy = (url.searchParams.get('selectBy') ?? 'd5') as SelectBy;
  const minSample = Math.max(1, Number(url.searchParams.get('minSample') ?? 5));
  const today = todayYmdTaipei(new Date());

  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return apiError('asOf must be YYYY-MM-DD', 400);
  if (!ALLOWED_SELECT.has(selectBy)) return apiError('selectBy must be d1|d5|d20', 400);
  if (asOf >= today) return apiError('asOf 必須早於今天（要有未來資料才能驗證跟單）', 400);

  try {
    // 一次載入全部歷史事件（資料量小，記憶體 filter 訓練/測試）
    const files = await loadRecoEventsInRange(today, 365);
    const sources = await loadSources();
    const displayById = new Map(sources.map(s => [s.source_id, s.display_name]));
    const resolveDisplayName = (id: string) => displayById.get(id) ?? id;

    const candleCache = new Map<string, BaselineCandle[] | null>();
    const getCandles = async (symbol: string): Promise<BaselineCandle[] | null> => {
      if (candleCache.has(symbol)) return candleCache.get(symbol)!;
      const c = await loadLocalCandles(symbol, 'TW');
      candleCache.set(symbol, c);
      return c;
    };
    const indexCandles = await getCandles('^TWII');

    // ── 1. 訓練：date < asOf，報酬 clamp 到 asOf（防前視） ──
    const trainEvents: RecoEventWithReturns[] = [];
    for (const f of files) {
      if (f.date >= asOf) continue;
      for (const ev of f.events) {
        const sc = ev.baseline.status === 'filled' ? await getCandles(ev.symbol) : null;
        trainEvents.push({ ...ev, returns: computeEventReturns(ev, sc, indexCandles, { visibleUntil: asOf }) });
      }
    }
    const trainRows = buildTeacherRows(trainEvents, resolveDisplayName);

    // 篩：該 horizon 有 ≥minSample 個已走完樣本，按平均報酬排序取 top-K
    const eligible = trainRows
      .filter(r => r.byHorizon[selectBy].n >= minSample)
      .sort((a, b) => b.byHorizon[selectBy].avgPct - a.byHorizon[selectBy].avgPct);
    const selected = eligible.slice(0, topK);
    const selectedNames = new Set(selected.map(r => r.teacher));

    // ── 2. 跟單：date >= asOf，top-K 老師的新 scored 推薦 ──
    const buildFollowEvents = async (teacherFilter: ((t: string, kind: string) => boolean)): Promise<FollowEvent[]> => {
      const out: FollowEvent[] = [];
      for (const f of files) {
        if (f.date < asOf) continue;
        for (const ev of f.events) {
          if (ev.cohort !== 'scored' || ev.conflict || ev.baseline.status !== 'filled') continue;
          if (!teacherFilter(ev.teacher, ev.teacher_kind)) continue;
          const sc = await getCandles(ev.symbol);
          const r = computeEventReturns(ev, sc, indexCandles);  // 不 clamp = 看到今天
          out.push({
            date: ev.date, teacher: ev.teacher,
            stock_code: ev.stock_code, stock_name: ev.stock_name,
            recommendation_type: ev.recommendation_type,
            entry_open: ev.baseline.entry_open,
            hold: r?.holdReturn ?? null, holdExcess: r?.holdExcess ?? null,
            d1: r?.d1 ?? null, d5: r?.d5 ?? null,
            isOpen: r?.d5 == null,
          });
        }
      }
      return out;
    };

    const followEvents = await buildFollowEvents((t, kind) => kind === 'person' && selectedNames.has(t));
    // 基準線：同期全部 person scored 推薦（不挑老師）
    const allEvents = await buildFollowEvents((_, kind) => kind === 'person');

    const statBlock = (evs: FollowEvent[]) => ({
      events: evs.length,
      uniqueStocks: new Set(evs.map(e => e.stock_code)).size,
      hold: selStats(evs.map(e => e.hold)),
      holdExcessAvg: avg(evs.map(e => e.holdExcess)),
      d1: selStats(evs.map(e => e.d1)),
      d5: selStats(evs.map(e => e.d5)),
    });

    const marketReturn = indexCandles ? indexReturnBetween(indexCandles, asOf, today) : null;

    return apiOk({
      asOf,
      today,
      config: { topK, selectBy, minSample },
      train: {
        eventsUsed: trainEvents.length,
        teachersEligible: eligible.length,
        note: eligible.length < topK
          ? `截至 ${asOf} 只有 ${eligible.length} 位老師有 ≥${minSample} 個已走完 ${selectBy.toUpperCase()} 樣本（訓練窗偏短）`
          : null,
      },
      selectedTeachers: selected.map(r => ({
        teacher: r.teacher,
        programs: r.programs.map(p => p.display_name),
        trainScored: r.byHorizon[selectBy].n,
        trainAvg: r.byHorizon[selectBy].avgPct,
        trainWin: r.byHorizon[selectBy].winRatePct,
      })),
      follow: statBlock(followEvents),
      benchmarkAll: statBlock(allEvents),
      marketReturn,
      followEvents: followEvents.sort((a, b) => (b.hold ?? -999) - (a.hold ?? -999)),
      note:
        '訓練（選老師）只用 asOf 之前的資料、報酬封頂在 asOf，無前視偏誤；跟單報酬是 asOf 之後的真實表現。' +
        '「持有至今」= 隔日開盤買進抱到最新收盤。D5 只統計已走完 5 個交易日的子集。',
    });
  } catch (err) {
    return apiError(`teacher-walkforward failed: ${(err as Error).message}`, 500);
  }
}
