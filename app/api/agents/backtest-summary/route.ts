/**
 * GET /api/agents/backtest-summary
 *
 * 讀 data/agents/backtest/entry-gate-v2.json 回 summary stats。
 * UI 用這個資料顯示「過去 N 天 backtest：可進 X% / 觀望 Y% / 不可追 Z%」conviction label。
 *
 * 注意：backtest 是離線跑的（scripts/backtest-entry-gate-v2.ts），這個 API 只是讀檔。
 *      週度 cron 重跑後檔案會自動更新、API 不用改。
 */

import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { apiError, apiOk } from '@/lib/api/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GroupStat {
  key: string;
  n: number;
  winRate: number;
  avgReturn: number;
  medianReturn: number;
  avgMaxDD: number;
  medianMaxDD: number;
  avgMaxGain: number;
  rdRatio: number;
}

interface BacktestFile {
  generatedAt: string;
  range: { from: string; to: string; days: number };
  config: { holdDays: number };
  overall: GroupStat;
  byState: Record<string, GroupStat>;
  byStateAndRegime: Record<string, Record<string, GroupStat>>;
  sampleCount: number;
}

const BACKTEST_PATH = path.join(process.cwd(), 'data', 'agents', 'backtest', 'entry-gate-v2.json');

export async function GET(_req: NextRequest) {
  try {
    const raw = await fs.readFile(BACKTEST_PATH, 'utf8');
    const data = JSON.parse(raw) as BacktestFile;
    return apiOk({
      generatedAt: data.generatedAt,
      range: data.range,
      sampleCount: data.sampleCount,
      overall: data.overall,
      byState: data.byState,
      byStateAndRegime: data.byStateAndRegime,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return apiOk({ exists: false, message: 'No backtest yet — run scripts/backtest-entry-gate-v2.ts' });
    }
    return apiError(`load backtest failed: ${(err as Error).message}`, 500);
  }
}
