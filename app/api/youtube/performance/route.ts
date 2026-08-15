/**
 * GET /api/youtube/performance?date=YYYY-MM-DD
 *
 * 給 /mockup/youtube-replay 用：一次回傳該日 YouTube 提及的股票
 * + 出自哪些節目 + 自基準日（= analysis date）後 N 日（1/3/5/10/20）漲跌。
 *
 * 流程：
 *   loadDailyAnalysis → deriveStockMentions → 對每檔 loadLocalCandles
 *   → computeNDayReturns（純函式）→ 合併 sources 細節 → response
 *
 * 邊界：
 *   - 無 analysis 檔 → items=[] + message
 *   - 找不到 K 線 → performance.status='no_data'
 *   - 基準日太新（N 越界）→ 該欄 null、status='stale'
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { deriveStockMentions, loadDailyAnalysis } from '@/lib/youtube/analysisStorage';
import { loadSources, loadVideosForDate } from '@/lib/youtube/videoStorage';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { computeNDayReturns, type NDayReturns } from '@/lib/youtube/performance';
import { injectL2TodayIfNeeded } from '@/lib/datasource/injectL2Today';
import { computeEntryState, type EntryGateResult } from '@/lib/agents/entryGate';
import { detectMarketRegime, thresholdsForRegime, type RegimeDetectResult } from '@/lib/agents/marketRegime';
import type { StockSentiment, StockRating } from '@/lib/youtube/analysisStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface PerformanceItemSource {
  source_id: string;
  display_name: string;
  video_id: string;
  video_title: string;
  video_url: string;
  sentiment: StockSentiment;
  reason: string;
  /** 該集影片講這檔股票的分析師（從 video.analysts 或 mention.analysts 帶下來）*/
  analysts: string[];
  /** 主持人原話片段 — 一般比 reason 完整 */
  context: string;
}

export interface PerformanceItem {
  stock_code: string;
  stock_name: string;
  market: 'TW' | 'CN';
  rating?: StockRating;
  composite_score?: number;
  mention_count: number;
  bullish_count: number;
  bearish_count: number;
  best_confidence: number;
  sources: PerformanceItemSource[];
  performance: NDayReturns;
  /** as-of analysis date 的進場時機 gate（書本規則：連 2 漲停 / 月線乖離 / 末升段 → no_chase）*/
  entryGate?: EntryGateResult;
}

export interface ConsensusSummary {
  generated_at: string;
  is_placeholder?: boolean;
  /** 有值=該日評分用的是這天的行情（補跑造成的前視），非分析當日 */
  scoring_data_asof?: string;
  market_view: string;
  bullish_consensus: string[];
  bearish_consensus: string[];
  stats: {
    videos_analyzed: number;
    high_consensus_count: number;
    weak_signal_count: number;
  };
}

export interface PerformanceResponse {
  date: string;
  baseDate: string;
  items: PerformanceItem[];
  consensus?: ConsensusSummary;
  /** 大盤 regime — 強多頭時 entryGate 閾值放寬 */
  marketRegime?: RegimeDetectResult;
  message?: string;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayYmdTaipei(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError('date must be YYYY-MM-DD', 400);
  }

  try {
    const analysis = await loadDailyAnalysis(date);
    if (!analysis) {
      return apiOk<PerformanceResponse>({
        date,
        baseDate: date,
        items: [],
        message: '此日無 YouTube 分析資料',
      });
    }

    const mentions = deriveStockMentions(analysis);
    const [sources, videos, indexCandles] = await Promise.all([
      loadSources(),
      loadVideosForDate(date),
      loadLocalCandles('^TWII', 'TW'),
    ]);
    const indexAsOf = indexCandles ? indexCandles.filter(c => c.date <= date) : null;
    const marketRegime = detectMarketRegime(indexAsOf);
    const gateThresholds = thresholdsForRegime(marketRegime.regime);
    const sourceById = new Map(sources.map(s => [s.source_id, s]));
    const videoById = new Map(videos.map(v => [v.video_id, v]));

    const items: PerformanceItem[] = await Promise.all(
      mentions.stocks.map(async (m) => {
        // K 線檔案命名為 `{code}.TW.json`，要帶後綴；上櫃股 fallback .TWO
        let candles = await loadLocalCandles(`${m.stock_code}.TW`, 'TW');
        let symbolForInject = `${m.stock_code}.TW`;
        if (!candles || candles.length === 0) {
          candles = await loadLocalCandles(`${m.stock_code}.TWO`, 'TW');
          symbolForInject = `${m.stock_code}.TWO`;
        }
        // 盤中今日 L1 cron 還沒寫今日封存 K → 從 L2 snapshot inject,
        // 跟 ForwardAnalyzer / 候選池 / 多代理走的 forward API 同一管線,確保即時可看漲幅
        candles = await injectL2TodayIfNeeded(candles, symbolForInject, 'TW', date);
        const perf = candles
          ? computeNDayReturns(candles, date)
          : {
              status: 'no_data' as const,
              baseClose: null,
              openReturn: null,
              d1Return: null, d2Return: null, d3Return: null, d4Return: null, d5Return: null,
              d6Return: null, d7Return: null, d8Return: null, d9Return: null, d10Return: null,
              d20Return: null,
              maxGain: null, maxLoss: null,
            };

        // entry_state 評估「as-of analysis date 收盤後能不能進場」— 切到 date，套用大盤 regime 對應的閾值
        const asOf = candles ? candles.filter(c => c.date <= date) : [];
        const entryGate = asOf.length >= 2 && asOf[asOf.length - 1].date === date
          ? computeEntryState({ symbol: m.stock_code, candles: asOf, thresholds: gateThresholds })
          : undefined;

        const sourcesArr: PerformanceItemSource[] = m.mentioned_in.map(mi => {
          const src = sourceById.get(mi.source_id);
          const vid = videoById.get(mi.video_id);
          return {
            source_id: mi.source_id,
            display_name: src?.display_name ?? mi.source_id,
            video_id: mi.video_id,
            video_title: vid?.title ?? '(影片資料缺失)',
            video_url: vid?.url ?? `https://www.youtube.com/watch?v=${mi.video_id}`,
            sentiment: mi.sentiment,
            reason: mi.reason,
            analysts: mi.analysts || vid?.analysts || [],
            context: mi.context || mi.reason || '',
          };
        });

        return {
          stock_code: m.stock_code,
          stock_name: m.stock_name,
          market: 'TW' as const,
          rating: m.scoring?.rating,
          composite_score: m.scoring?.composite_score,
          mention_count: m.mention_count,
          bullish_count: m.bullish_count,
          bearish_count: m.bearish_count,
          best_confidence: m.best_confidence,
          sources: sourcesArr,
          performance: perf,
          entryGate,
        };
      }),
    );

    const consensus: ConsensusSummary = {
      generated_at: analysis.generated_at,
      is_placeholder: analysis.is_placeholder,
      scoring_data_asof: analysis.scoring_data_asof,
      market_view: analysis.market_view,
      bullish_consensus: analysis.bullish_consensus ?? [],
      bearish_consensus: analysis.bearish_consensus ?? [],
      stats: {
        videos_analyzed: analysis.stats.videos_analyzed,
        high_consensus_count: analysis.stats.high_consensus_count,
        weak_signal_count: analysis.stats.weak_signal_count,
      },
    };

    return apiOk<PerformanceResponse>({ date, baseDate: date, items, consensus, marketRegime });
  } catch (err) {
    return apiError(`performance failed: ${(err as Error).message}`, 500);
  }
}
