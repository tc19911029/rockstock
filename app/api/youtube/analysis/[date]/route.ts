/**
 * GET /api/youtube/analysis/[date]
 *
 * 回傳 Claude 寫的當日分析 (data/youtube/analysis/{date}.json)。
 *
 * 路徑 date 用 YYYY-MM-DD（Asia/Taipei）。
 */

import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { loadDailyAnalysis } from '@/lib/youtube/analysisStorage';
import { loadLocalCandlesForDate } from '@/lib/datasource/LocalCandleStore';
import { computeEntryState, type EntryGateResult } from '@/lib/agents/entryGate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loadCandlesForCode(code: string, asOf: string) {
  const tw = await loadLocalCandlesForDate(`${code}.TW`, 'TW', asOf);
  if (tw && tw.length > 0) return tw;
  return loadLocalCandlesForDate(`${code}.TWO`, 'TW', asOf);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ date: string }> },
) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError('date must be YYYY-MM-DD', 400);
  }
  try {
    const analysis = await loadDailyAnalysis(date);
    if (!analysis) {
      return apiOk({
        analysis: null,
        message: '此日無 YouTube 分析資料',
      });
    }

    const entryGates: Record<string, EntryGateResult> = {};
    const codes = new Set<string>();
    for (const s of analysis.stock_scoring ?? []) {
      if (s?.stock_code) codes.add(s.stock_code);
    }
    await Promise.all(
      [...codes].map(async (code) => {
        try {
          const candles = await loadCandlesForCode(code, date);
          if (!candles || candles.length === 0) return;
          const last = candles[candles.length - 1];
          if (!last || last.date !== date) return;
          entryGates[code] = computeEntryState({ symbol: code, candles });
        } catch {
          /* ignore per-symbol error, keep analysis served */
        }
      }),
    );

    return apiOk({ analysis, entryGates });
  } catch (err) {
    return apiError(`loadDailyAnalysis failed: ${(err as Error).message}`, 500);
  }
}
