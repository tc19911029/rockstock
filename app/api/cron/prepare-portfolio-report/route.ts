/**
 * Cron：準備月/季/年報 question.json（Phase 1.3）
 *
 *   GET /api/cron/prepare-portfolio-report?period=YYYY-MM&mode=monthly
 *   GET /api/cron/prepare-portfolio-report?period=2026-Q2&mode=quarterly
 *   GET /api/cron/prepare-portfolio-report?period=2026&mode=yearly
 *
 * 行為：
 *   1. 讀 trades.json + 切片到指定期間
 *   2. 算 metrics（整體 + 按字母 + 按月）
 *   3. 讀對應期間的 holdings snapshot（如果有 account.json 歷史快照則用，否則 best-effort）
 *   4. 寫 /tmp/rockstock-portfolio-report/{period}-question.json
 *   5. 由 /portfolio-report skill 在對話中讀檔 → 寫 markdown report
 *
 * 排程建議（vercel.json + launchd）：
 *   月底盤後 14:30 CST 跑 mode=monthly
 *   季底 14:30 CST 跑 mode=quarterly
 *   12/31 14:30 CST 跑 mode=yearly
 */

import { NextRequest } from 'next/server';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { loadTrades } from '@/lib/portfolio/tradeRecorder';
import {
  computeMetrics,
  computeMetricsByLetter,
  filterTradesByDateRange,
} from '@/lib/portfolio/perfMetrics';
import { loadAccount } from '@/lib/portfolio/account';

export const runtime = 'nodejs';

const querySchema = z.object({
  period: z.string().min(1),
  mode: z.enum(['monthly', 'quarterly', 'yearly']),
});

/** 把 period+mode 換成 startDate / endDate（含端點）*/
function dateRangeOf(period: string, mode: 'monthly' | 'quarterly' | 'yearly'): {
  start: string; end: string;
} {
  if (mode === 'monthly') {
    // period = 'YYYY-MM'
    if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('monthly period 需 YYYY-MM');
    const [y, m] = period.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate(); // m 是 1-12，傳 0 拿上月最後一天
    return { start: `${period}-01`, end: `${period}-${String(lastDay).padStart(2, '0')}` };
  }
  if (mode === 'quarterly') {
    // period = 'YYYY-Q1' .. 'YYYY-Q4'
    const m = /^(\d{4})-Q([1-4])$/.exec(period);
    if (!m) throw new Error('quarterly period 需 YYYY-Q[1-4]');
    const y = Number(m[1]);
    const q = Number(m[2]);
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = q * 3;
    const lastDay = new Date(y, endMonth, 0).getDate();
    return {
      start: `${y}-${String(startMonth).padStart(2, '0')}-01`,
      end: `${y}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  // yearly
  if (!/^\d{4}$/.test(period)) throw new Error('yearly period 需 YYYY');
  return { start: `${period}-01-01`, end: `${period}-12-31` };
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
  if (expected && auth !== expected) return apiError('unauthorized', 401);

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { period, mode } = parsed.data;

  let range: { start: string; end: string };
  try { range = dateRangeOf(period, mode); }
  catch (e) { return apiError(e instanceof Error ? e.message : 'invalid period', 400); }

  const all = await loadTrades();
  const trades = filterTradesByDateRange(all.trades, range.start, range.end);

  const overall = computeMetrics(trades);
  const byLetter = computeMetricsByLetter(trades);

  // 按月切（年報/季報用）
  const byMonth: Record<string, ReturnType<typeof computeMetrics>> = {};
  if (mode !== 'monthly') {
    const monthBuckets: Record<string, typeof trades> = {};
    for (const t of trades) {
      const ym = t.exitDate.slice(0, 7);
      (monthBuckets[ym] ??= []).push(t);
    }
    for (const [ym, ts] of Object.entries(monthBuckets)) {
      byMonth[ym] = computeMetrics(ts);
    }
  }

  const account = await loadAccount();

  const question = {
    schemaVersion: 1,
    period,
    mode,
    dateRange: range,
    generatedAt: new Date().toISOString(),
    summary: {
      tradesCount: trades.length,
      overall,
      byLetter,
      byMonth,
    },
    trades,                  // 完整 trade list，給 skill 細看用
    accountSnapshot: {
      cash: account.cash,
      stockValue: account.stockValue,
      totalCapital: account.totalCapital,
      asOfDate: account.asOfDate,
      holdingsCount: account.holdingsSnapshot.length,
    },
    outputPath: `data/agents/portfolio/reports/${mode}/${period}.md`,
  };

  const tmpDir = '/tmp/rockstock-portfolio-report';
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `${period}-question.json`);
  await atomicFsPut(tmpFile, JSON.stringify(question, null, 2));

  return apiOk({
    period,
    mode,
    dateRange: range,
    tradesCount: trades.length,
    questionPath: tmpFile,
    outputPath: question.outputPath,
    nextStep: `請在 Claude Code 對話中執行 /portfolio-report ${period}`,
  });
}
