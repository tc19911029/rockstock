/**
 * Paper Portfolio Tick — 每日盤後 cron
 *
 * 跑 lib/paper/paperTradeSimulator 對 TW 市場（用 TW_PROD_CONFIG = sweep winning combo），
 * 寫累計快照到 data/paper-portfolio/。
 *
 * GET /api/cron/paper-portfolio-tick
 *
 * 排程建議（vercel.json）：
 *   TW 盤後 15:30 CST = UTC 07:30 → "30 7 * * 1-5"
 *
 * 輸出：
 *   data/paper-portfolio/equity-curve-TW.json     ← 覆蓋最新累計
 *   data/paper-portfolio/history/TW-{date}.json   ← 歷史快照
 *
 * 注意（Vercel 限制）：
 * - production serverless 環境只允許寫 /tmp，data/ 不可寫
 * - 本路由本地 dev / 自架機 OK；Vercel deploy 需追加 Vercel Blob 適配
 *   見任務「Vercel Blob 適配 paper portfolio cron」（追加在 baseline-kpi.md）
 *
 * CN 暫不跑（baseline 27 組全 ❌，等 CN audit 任務 #8 完成）。
 */

import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { simulate, TW_PROD_CONFIG } from '@/lib/paper/paperTradeSimulator';

export const runtime = 'nodejs';
export const maxDuration = 60;

const OUT_DIR = path.join(process.cwd(), 'data', 'paper-portfolio');
const HISTORY_DIR = path.join(OUT_DIR, 'history');

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  // Vercel production fs 唯讀，cron route 無法 writeFileSync(data/...)。
  // 直到任務 #9 Blob 適配完成前，明確擋掉 Vercel cron 觸發。
  // 本地 launchd 跑 dev server cron 不受此擋。
  if (process.env.VERCEL === '1' && !process.env.PAPER_BLOB_ADAPTED) {
    return apiError(
      'paper-portfolio-tick: Vercel Blob 適配尚未完成（任務 #9）。請改用本地 launchd（scripts/launchd/plists/com.rockstock.paper-portfolio-tick.plist）。',
      503,
    );
  }

  try {
    // 確保 output dir 存在
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

    const result = simulate(TW_PROD_CONFIG, { verbose: false });

    // 覆蓋最新累計快照
    const latestPath = path.join(OUT_DIR, 'equity-curve-TW.json');
    fs.writeFileSync(latestPath, JSON.stringify(result, null, 2));

    // 歷史快照（按今天日期）
    const today = new Date().toISOString().slice(0, 10);
    const historyPath = path.join(HISTORY_DIR, `TW-${today}.json`);
    fs.writeFileSync(historyPath, JSON.stringify({
      tickAt: new Date().toISOString(),
      sessionsCount: result.days.length,
      totalSignals: result.totalSignals,
      totalPicks: result.totalPicks,
      totalWins: result.totalWins,
      winRate: result.winRate,
      avgReturn: result.avgReturn,
      finalEquity: result.finalEquity,
      totalReturn: result.totalReturn,
      lastDayEquity: result.equityCurve[result.equityCurve.length - 1] ?? null,
      lastDayPicks: result.days[result.days.length - 1]?.picksDetail ?? [],
    }, null, 2));

    return apiOk({
      ok: true,
      market: 'TW',
      sessionsCount: result.days.length,
      totalPicks: result.totalPicks,
      winRate: result.winRate,
      avgReturn: result.avgReturn,
      totalReturn: result.totalReturn,
      finalEquity: result.finalEquity,
      writtenTo: {
        latest: path.relative(process.cwd(), latestPath),
        history: path.relative(process.cwd(), historyPath),
      },
    });
  } catch (err) {
    console.error('[paper-portfolio-tick] failed:', err);
    return apiError(
      err instanceof Error ? err.message : 'paper portfolio tick failed',
      500,
    );
  }
}
