import { NextRequest, NextResponse } from 'next/server';
import { readLeaderboardSnapshot, buildLeaderboardSnapshot } from '@/lib/cn-agents/backtest/leaderboardSnapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * 陸股回測排行榜 — 預設讀預算快照（即時）；?live=1 強制重算（慢 ~50s，除錯用）。
 * 快照由 reco cron 結算後 rebuild（lib/cn-agents/backtest/leaderboardSnapshot）。
 */
export async function GET(req: NextRequest) {
  const live = req.nextUrl.searchParams.get('live') === '1';
  try {
    const snap = live ? await buildLeaderboardSnapshot() : await readLeaderboardSnapshot();
    if (!snap) {
      return NextResponse.json({ ok: true, meta: { totalEvents: 0, note: '快照尚未產生（reco 結算後 rebuild）' }, modePhase: [], tiers: [], sources: [] });
    }
    return NextResponse.json({ ok: true, builtAt: snap.builtAt, meta: snap.meta, modePhase: snap.modePhase, tiers: snap.tiers, sources: snap.sources, stages: snap.stages ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'leaderboard 失敗' }, { status: 500 });
  }
}
