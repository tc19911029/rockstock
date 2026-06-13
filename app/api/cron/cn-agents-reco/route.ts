import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { buildHardScoreEvents } from '@/lib/cn-agents/hardScore';
import { settlePendingEvents } from '@/lib/cn-agents/backtest/recoPipeline';
import { readRecoEvents } from '@/lib/cn-agents/storage';
import { buildLeaderboardSnapshot, saveLeaderboardSnapshot } from '@/lib/cn-agents/backtest/leaderboardSnapshot';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * 陸股情緒回測事件 cron：
 *   step 1 — 當日 hard_score_v0 事件抽取（需 cn-agents-eod + cn-agents-lhb 先落地；
 *            已存在且非 ?force=1 → skip）
 *   step 2 — 結算所有 pending 事件 baseline（昨日事件在今日 K 封存後可結）
 * ?date=YYYY-MM-DD 回補某日。
 */
export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const force = req.nextUrl.searchParams.get('force') === '1';
  const date = dateParam ?? getLastTradingDay('CN');

  if (!force && !isTradingDay(date, 'CN')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  try {
    let extracted: { events: number; skipped: boolean };
    const existing = await readRecoEvents(date);
    if (existing && !force) {
      extracted = { events: existing.events.length, skipped: true };
    } else {
      const file = await buildHardScoreEvents(date);
      extracted = { events: file.events.length, skipped: false };
    }
    const settle = await settlePendingEvents();
    // 結算後 rebuild 排行榜快照（UI 即時讀，避免 live 重算 ~50s）
    let snapshot: { totalEvents: number } | null = null;
    try {
      const snap = await buildLeaderboardSnapshot();
      await saveLeaderboardSnapshot(snap);
      snapshot = { totalEvents: snap.meta.totalEvents };
    } catch (e) { void e; }
    return apiOk({ ok: true, date, extracted, settle, snapshot });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : '陸股回測事件 cron 失敗', 500);
  }
}
