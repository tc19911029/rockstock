import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import type { StrategyAudit } from '@/lib/health/strategyAudit';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  const market = req.nextUrl.searchParams.get('market');
  if (market !== 'TW' && market !== 'CN') return apiError('market must be TW or CN', 400);
  try {
    const report: StrategyAudit = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data/reports/strategy-audit', `${market}.json`), 'utf8'));
    const stale = report.endDate !== getLastTradingDay(market)
      || !Number.isFinite(Date.parse(report.checkedAt))
      || (report.status === 'checking' && Date.now() - Date.parse(report.checkedAt) > 10 * 60_000);
    return apiOk({ ...report, stale });
  } catch (error) {
    return apiError((error as NodeJS.ErrnoException).code === 'ENOENT' ? '尚未完成歷史策略巡檢' : '策略巡檢報告無法讀取', 503);
  }
}
