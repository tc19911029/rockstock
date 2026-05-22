/**
 * GET /api/youtube/report/[date]?format=md|json
 *
 * 把當日 DailyAnalysis 整理成可分享的 markdown 報告（MVP 6）。
 * 預設 format=md，回傳 text/markdown；format=json 則直接回原始 DailyAnalysis JSON。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { loadDailyAnalysis } from '@/lib/youtube/analysisStorage';
import { renderMarkdownReport } from '@/lib/youtube/markdownReport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ date: string }> },
) {
  const { date } = await ctx.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError('date must be YYYY-MM-DD', 400);
  }
  const url = new URL(req.url);
  const format = (url.searchParams.get('format') ?? 'md').toLowerCase();
  const download = url.searchParams.get('download') === '1';

  const analysis = await loadDailyAnalysis(date);
  if (!analysis) {
    if (format === 'md') {
      return new Response(`# 無資料\n\n${date} 還沒有 analysis 檔。\n`, {
        status: 404, headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      });
    }
    return apiError(`no analysis for ${date}`, 404);
  }

  if (format === 'json') {
    return apiOk({ analysis });
  }

  if (format === 'md') {
    const body = renderMarkdownReport(analysis);
    const headers: Record<string, string> = {
      'Content-Type': 'text/markdown; charset=utf-8',
    };
    if (download) {
      headers['Content-Disposition'] = `attachment; filename="youtube-report-${date}.md"`;
    }
    return new Response(body, { status: 200, headers });
  }

  return apiError(`format must be md or json (got: ${format})`, 400);
}
