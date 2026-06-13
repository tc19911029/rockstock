/**
 * 排行榜快照（P4）— 預算好的交叉勝率表，存成單一檔給 UI 即時讀
 *
 * 為什麼要快照：loadEventsWithReturns 對 16k 事件逐檔載 K 線算報酬，單次 ~50s，
 * 當 live API 會 timeout。報酬雖不持久化（K 線靜態、可重算），但「算一次存結果」
 * 對歷史事件完全正確（已走完的報酬不會變）。reco 結算後 rebuild 一次即可。
 *
 * 存 data/cn-agents/leaderboard.json（單檔 dual-storage）。
 */

import { loadEventsWithReturns } from './recoPipeline';
import { buildModePhaseCrossTable, buildTierTable, buildSourceTable, buildStageTable, LOW_SAMPLE_N } from './crossTable';
import type { CrossCell, TierCell, SourceCell, StageCell } from './crossTable';
import { putJsonRoot, getJsonRoot } from '../storage';

export interface LeaderboardSnapshot {
  schemaVersion: number;
  builtAt: string;
  days: number;
  meta: { totalEvents: number; lowSampleN: number; note: string };
  modePhase: CrossCell[];
  tiers: TierCell[];
  sources: SourceCell[];
  stages: StageCell[];
}

const SNAPSHOT_DAYS = 400;

export async function buildLeaderboardSnapshot(days = SNAPSHOT_DAYS): Promise<LeaderboardSnapshot> {
  const events = await loadEventsWithReturns(days);
  return {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    days,
    meta: {
      totalEvents: events.length,
      lowSampleN: LOW_SAMPLE_N,
      note: 'tier C 是避開名單驗證（win 語意=跌）；交叉表只含 A/B；隔日開盤進場、一字 no_fill 排除；報酬即時 derive 後快照；超額 vs 上證',
    },
    modePhase: buildModePhaseCrossTable(events),
    tiers: buildTierTable(events),
    sources: buildSourceTable(events),
    stages: buildStageTable(events),
  };
}

export async function saveLeaderboardSnapshot(snap: LeaderboardSnapshot): Promise<void> {
  await putJsonRoot('leaderboard.json', snap);
}
export async function readLeaderboardSnapshot(): Promise<LeaderboardSnapshot | null> {
  return getJsonRoot<LeaderboardSnapshot>('leaderboard.json');
}
