/**
 * GET /api/youtube/daily-summary/[date]
 *
 * 每日節目總結報告（首頁 YouTube「總結」子分頁的資料來源）— server-side 一次組齊：
 *   ① 跨節目總結論（analysis 既有 market_view + 多空共識）
 *   ② 持倉提醒（buildHoldingAlerts：持倉 × 當日 mentions 純程式 join，不進 LLM）
 *   ③ 節目卡片（analysis.video_summaries，按 must_watch → skim → skip 排好）
 *
 * 為何 server route 而非前端雙 fetch：持倉檔是純本地 FS（server 唯一真相）、
 * join 規則（symbol 後綴剝除 + 信心門檻）只放 server 一份、首頁 mount 少一次請求（429 教訓）。
 *
 * 邊界：
 *   - 無 analysis 檔 → has_analysis=false，全空
 *   - 舊 analysis 無 video_summaries → has_video_summaries=false，①② 照出、videos=[]
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { loadDailyAnalysis, type DailyAnalysis, type VideoSummary, type WatchPriority } from '@/lib/youtube/analysisStorage';
import { loadSources } from '@/lib/youtube/videoStorage';
import { buildHoldingAlerts, type HoldingAlert } from '@/lib/youtube/holdingAlerts';
import { loadAllHoldings } from '@/lib/agents/portfolio/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type { HoldingAlert };

export interface DailySummaryResponse {
  date: string;
  generated_at: string | null;
  has_analysis: boolean;
  has_video_summaries: boolean;
  is_placeholder?: boolean;
  /** 有值=該日評分用的是這天的行情（補跑造成的前視），非分析當日 */
  scoring_data_asof?: string;
  consensus: {
    market_view: string;
    bullish_consensus: string[];
    bearish_consensus: string[];
    stats: DailyAnalysis['stats'];
  } | null;
  /** 已按 must_watch → skim → skip 排好（同級按節目名） */
  videos: VideoSummary[];
  holding_alerts: HoldingAlert[];
}

const PRIORITY_ORDER: Record<WatchPriority, number> = { must_watch: 0, skim: 1, skip: 2 };

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ date: string }> },
) {
  const { date } = await ctx.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError('date must be YYYY-MM-DD', 400);
  }

  try {
    const analysis = await loadDailyAnalysis(date);
    if (!analysis) {
      return apiOk<DailySummaryResponse>({
        date,
        generated_at: null,
        has_analysis: false,
        has_video_summaries: false,
        consensus: null,
        videos: [],
        holding_alerts: [],
      });
    }

    // 注意：loadAllHoldings（TW+CN 一次拿齊），不可用 listOpenHoldings（TW-only 會漏陸股）
    const [sources, holdings] = await Promise.all([
      loadSources().catch(() => []),
      loadAllHoldings().catch(() => []),
    ]);
    const sourceNameById = new Map(sources.map(s => [s.source_id, s.display_name]));
    const sourceNameOf = (id: string) => sourceNameById.get(id) ?? id;

    const videos = [...(analysis.video_summaries ?? [])].sort((a, b) => {
      const pa = PRIORITY_ORDER[a.watch_priority] ?? 9;
      const pb = PRIORITY_ORDER[b.watch_priority] ?? 9;
      if (pa !== pb) return pa - pb;
      return a.source_name.localeCompare(b.source_name, 'zh-Hant');
    });

    return apiOk<DailySummaryResponse>({
      date,
      generated_at: analysis.generated_at,
      has_analysis: true,
      has_video_summaries: videos.length > 0,
      is_placeholder: analysis.is_placeholder,
      scoring_data_asof: analysis.scoring_data_asof,
      consensus: {
        market_view: analysis.market_view,
        bullish_consensus: analysis.bullish_consensus,
        bearish_consensus: analysis.bearish_consensus,
        stats: analysis.stats,
      },
      videos,
      holding_alerts: buildHoldingAlerts(analysis, holdings, sourceNameOf),
    });
  } catch (err) {
    console.error('[daily-summary] failed:', err);
    return apiError(err instanceof Error ? err.message : 'internal error', 500);
  }
}
