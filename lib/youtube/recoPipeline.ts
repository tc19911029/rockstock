/**
 * 推薦事件 pipeline orchestration — backfill 腳本與 cron route 共用。
 *
 *   extractAndSettleForDate(date)：analysis → 抽事件（保留舊 baseline）→ 結算 pending → 存檔
 *   settleAllPendingDates()：掃全部事件檔，結算還 pending 的基準價（隔日 K 封存後補結）
 *
 * 結算用 L1 本地 K 線（loadLocalCandles 內建快取）；symbol 載不到時換 .TW/.TWO
 * 另一後綴重試一次（同 /api/youtube/performance 慣例），成功後凍結回事件。
 */

import { loadDailyAnalysis } from './analysisStorage';
import { loadSources, loadVideosForDate } from './videoStorage';
import { extractRecoEvents, mergePreservingBaselines } from './recoEvents';
import { settleBaseline } from './recoBaseline';
import { listRecoDates, loadRecoEvents, saveRecoEvents } from './recoStorage';
import type { RecoEvent, RecoEventsFile } from './recoTypes';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';

export interface SettleStats {
  settled: number;     // 本次新結算（filled/no_fill/no_data）
  pending: number;     // 仍待隔日 K
  already: number;     // 先前已結算
}

function altSuffix(symbol: string): string {
  return symbol.endsWith('.TWO')
    ? symbol.replace(/\.TWO$/, '.TW')
    : symbol.replace(/\.TW$/, '.TWO');
}

/** 結算單一事件（in place）。回傳是否有變動。 */
async function settleEvent(ev: RecoEvent, now: string): Promise<boolean> {
  if (ev.baseline.status !== 'pending') return false;

  let symbol = ev.symbol;
  let candles = await loadLocalCandles(symbol, 'TW');
  if (!candles || candles.length === 0) {
    const alt = altSuffix(symbol);
    candles = await loadLocalCandles(alt, 'TW');
    if (candles && candles.length > 0) symbol = alt;
  }

  const baseline = settleBaseline(ev.date, candles, now);
  ev.baseline = baseline;
  if (baseline.status !== 'pending') ev.symbol = symbol;  // 凍結實際可載的後綴
  return baseline.status !== 'pending';
}

export interface ExtractResult {
  file: RecoEventsFile;
  isNew: boolean;        // 本次是否（重）抽取（false = analysis 沒變，只補結算）
  stats: SettleStats;
}

/**
 * 對單一日期抽取 + 結算 + 存檔。
 * @param force 即使 analysis generated_at 沒變也重抽
 * @returns null = 該日無 analysis 檔
 */
export async function extractAndSettleForDate(
  date: string,
  opts: { force?: boolean; dryRun?: boolean; now?: string } = {},
): Promise<ExtractResult | null> {
  const now = opts.now ?? new Date().toISOString();
  const analysis = await loadDailyAnalysis(date);
  if (!analysis) return null;

  const existing = await loadRecoEvents(date);
  const needExtract =
    opts.force ||
    !existing ||
    existing.source_analysis_generated_at !== analysis.generated_at;

  let file: RecoEventsFile;
  if (needExtract) {
    const [sources, videos] = await Promise.all([loadSources(), loadVideosForDate(date)]);
    const extracted = extractRecoEvents(analysis, {
      displayNameBySource: new Map(sources.map(s => [s.source_id, s.display_name])),
      analystsByVideo: new Map(videos.map(v => [v.video_id, v.analysts ?? []])),
    });
    file = {
      ...extracted,
      events: mergePreservingBaselines(extracted.events, existing?.events),
      generated_at: now,
    };
  } else {
    file = existing!;
  }

  const stats: SettleStats = { settled: 0, pending: 0, already: 0 };
  for (const ev of file.events) {
    if (ev.baseline.status !== 'pending') { stats.already += 1; continue; }
    const changed = await settleEvent(ev, now);
    if (changed) stats.settled += 1; else stats.pending += 1;
  }

  if (!opts.dryRun && (needExtract || stats.settled > 0)) {
    file.generated_at = now;
    await saveRecoEvents(file);
  }

  return { file, isNew: needExtract, stats };
}

/** 結算所有日期檔中還 pending 的事件（每日盤後 cron 用）。 */
export async function settleAllPendingDates(
  opts: { dryRun?: boolean; now?: string } = {},
): Promise<Record<string, SettleStats>> {
  const now = opts.now ?? new Date().toISOString();
  const out: Record<string, SettleStats> = {};
  for (const date of await listRecoDates()) {
    const file = await loadRecoEvents(date);
    if (!file) continue;
    const stats: SettleStats = { settled: 0, pending: 0, already: 0 };
    for (const ev of file.events) {
      if (ev.baseline.status !== 'pending') { stats.already += 1; continue; }
      const changed = await settleEvent(ev, now);
      if (changed) stats.settled += 1; else stats.pending += 1;
    }
    if (stats.settled > 0 && !opts.dryRun) {
      file.generated_at = now;
      await saveRecoEvents(file);
    }
    if (stats.settled > 0 || stats.pending > 0) out[date] = stats;
  }
  return out;
}
