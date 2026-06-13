/**
 * GET /api/cn-agents/breadth?days=30
 *
 * 陸股情緒儀表板（/health?tab=cn-agents）的單一讀取入口 —
 * 一個 route 餵整個 tab，避免前端打 4 支 API 各自處理缺檔：
 *   1. 近 N 日寬度 + 情緒週期序列（readBreadthIndex 切尾）
 *   2. 最新日漲停池摘要 + 連板梯隊 top 10（readLimitUpPoolDay）
 *   3. 最新日板塊強弱：行業 / 概念漲幅 top 10（readBoardsDay）
 *   4. 最新日 cron 步驟健康（readCnAgentsHealth）
 *
 * 「最新日」的取法：index 有資料 → 取序列最後一天；index 還沒建
 * （首日 / 回填前）→ fallback 今日 CST，讓「盤後 cron 跑到一半
 * （漲停池已存、寬度還沒算）」的中間態也能顯示部分資料。
 *
 * 缺檔語意：pool / boards / health 任一檔不存在一律回 null（非 error），
 * 由前端 CnAgentsTab 顯示「尚無資料」提示 — 這是日常狀態（白天 cron
 * 還沒跑）不是故障，不可回 5xx。
 */

import { apiOk, apiError } from '@/lib/api/response';
import {
  readBreadthIndex,
  readLimitUpPoolDay,
  readBoardsDay,
  readCnAgentsHealth,
} from '@/lib/cn-agents/storage';
import type { BoardEntry, LimitUpPoolDay } from '@/lib/cn-agents/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 120; // 對齊 BREADTH_INDEX_MAX_DAYS，再多也沒資料

/** 今日 CST（台北/北京同 UTC+8）YYYY-MM-DD */
function todayCst(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 連板梯隊 top 10：非 ST（與 stats.heightDist 語意一致）按板數降冪、同板數比封單額 */
function buildLadder(pool: LimitUpPoolDay) {
  return [...pool.limitUp]
    .filter((e) => !e.isST)
    .sort(
      (a, b) =>
        b.consecBoards - a.consecBoards ||
        (b.sealAmountCny ?? 0) - (a.sealAmountCny ?? 0),
    )
    .slice(0, 10)
    .map((e) => ({
      symbol: e.symbol,
      name: e.name,
      consecBoards: e.consecBoards,
      industry: e.industry,
      isOneWord: e.isOneWord,
    }));
}

/** 同 kind 內按 rank（漲幅名次，1-based）取前 N */
function topByRank(entries: BoardEntry[], n = 10): BoardEntry[] {
  return [...entries].sort((a, b) => a.rank - b.rank).slice(0, n);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const raw = Number(url.searchParams.get('days') ?? DEFAULT_DAYS);
    const days = Number.isFinite(raw)
      ? Math.min(MAX_DAYS, Math.max(1, Math.floor(raw)))
      : DEFAULT_DAYS;

    const index = await readBreadthIndex();
    const series = index?.days ? index.days.slice(-days) : [];
    const latestDate =
      series.length > 0 ? series[series.length - 1].date : todayCst();

    const [pool, boards, health] = await Promise.all([
      readLimitUpPoolDay(latestDate),
      readBoardsDay(latestDate),
      readCnAgentsHealth(latestDate),
    ]);

    return apiOk({
      latestDate: series.length > 0 || pool || boards || health ? latestDate : null,
      days: series,
      pool: pool
        ? {
            date: pool.date,
            fetchedAt: pool.fetchedAt,
            source: pool.source,
            stats: pool.stats,
            breadth: pool.breadth,
            ladder: buildLadder(pool),
          }
        : null,
      boards: boards
        ? {
            date: boards.date,
            fetchedAt: boards.fetchedAt,
            source: boards.source,
            industries: topByRank(boards.industries),
            concepts: topByRank(boards.concepts),
          }
        : null,
      health,
    });
  } catch (err) {
    return apiError(
      `cn-agents breadth 讀取失敗: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
