/**
 * POST /api/cron/youtube-scan
 *
 * 每日掃描 YouTube 來源（MVP 1：抓得穩）。
 *
 * 為何放在 cron route 但實際是 launchd 觸發：延續 repo 慣例，plist → curl → API route。
 * yt-dlp 是系統 binary 不能在 Vercel serverless 跑 → 此 route 不在 vercel.json 註冊，
 * 只接受 localhost 觸發（CRON_SECRET 仍會驗證）。
 *
 * Query:
 *   ?source_id=...   只跑單一來源
 *   ?dry_run=1       不寫盤
 */

import { NextRequest } from 'next/server';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { scanOneSource } from '@/lib/youtube/scanRunner';
import {
  loadRecentScanLogs,
  loadSources,
  saveHealth,
  saveSources,
} from '@/lib/youtube/videoStorage';
import type {
  YouTubeHealthSnapshot,
  YouTubeSource,
  YouTubeSourceHealth,
  YouTubeSourceScanLog,
} from '@/lib/youtube/types';

export const runtime = 'nodejs';     // 必須 — yt-dlp 走 child_process
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  // 方便手動 curl 測試
  return handle(req);
}

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const filterSourceId = url.searchParams.get('source_id');
  const dryRun = url.searchParams.get('dry_run') === '1';
  const force = url.searchParams.get('force') === '1';   // 跳過 already-scanned-today 快取
  const targetDateParam = url.searchParams.get('date'); // 嚴格同日過濾 (Asia/Taipei YYYY-MM-DD)
  if (targetDateParam && !/^\d{4}-\d{2}-\d{2}$/.test(targetDateParam)) {
    return apiError('date must be YYYY-MM-DD', 400);
  }

  const now = new Date();
  const scanDate = todayYmdTaipei(now);

  let sources: YouTubeSource[];
  try {
    sources = await loadSources();
  } catch (err) {
    return apiError(`loadSources failed: ${(err as Error).message}`, 500);
  }

  if (filterSourceId) {
    sources = sources.filter(s => s.source_id === filterSourceId);
    if (sources.length === 0) {
      return apiError(`source_id not found: ${filterSourceId}`, 404);
    }
  }

  // 軌道分批：?batch=i&of=n 把 active 來源切成 n 批、只掃第 i 批（i ∈ [0,n)）。
  // 為什麼：~17 來源 full-metadata 全掃 ~850s，遠超 curl --max-time 280 與本 route
  // maxDuration=300。用穩定取模切片（i % of），每批 ~4-5 來源 ~200s 內跑完。
  // plist 串接 0..n-1 批（順序執行、不並發 → 不會競寫共享的 video-index / videos /
  // scan-logs JSON）。health 重算在下方仍 loadSources() 讀全部來源，切片不影響聚合。
  const batchParam = url.searchParams.get('batch');
  const ofParam = url.searchParams.get('of');
  if (batchParam != null || ofParam != null) {
    const of = Number(ofParam);
    const batch = Number(batchParam);
    if (!Number.isInteger(of) || of < 1 || !Number.isInteger(batch) || batch < 0 || batch >= of) {
      return apiError('batch/of invalid: need integers with 0 <= batch < of and of >= 1', 400);
    }
    const activeIds = sources.filter(s => s.active).map(s => s.source_id);
    const pick = new Set(activeIds.filter((_, i) => i % of === batch));
    sources = sources.filter(s => pick.has(s.source_id));
  }

  // 拿前一天的 log 算 consecutive_empty_days 起算值
  const recentLogs = await loadRecentScanLogs(scanDate, 14);
  const prevEmptyMap = computePrevEmptyDays(scanDate, recentLogs);

  // 看今天是否已有掃描紀錄（重試 case）
  const todayLogs = recentLogs.get(scanDate) ?? [];
  const todayLogMap = new Map(todayLogs.map(l => [l.source_id, l]));

  const results: Array<{ source_id: string; log: YouTubeSourceScanLog }> = [];
  for (const source of sources) {
    if (!source.active) continue;
    const prevEmpty = prevEmptyMap.get(source.source_id) ?? 0;

    const existingLogToday = todayLogMap.get(source.source_id);
    // 若今天已成功跑過 (error=null, scanned>0)，跳過避免重複呼叫 YouTube
    // 帶 ?force=1 時繞過此快取（用於 reproc / 演算法變更後重算分類）
    if (!force && existingLogToday && existingLogToday.error == null && existingLogToday.scanned_count > 0) {
      results.push({ source_id: source.source_id, log: existingLogToday });
      continue;
    }

    try {
      const r = await scanOneSource({
        source,
        now: new Date(),
        dryRun,
        prevConsecutiveEmptyDays: prevEmpty,
        targetDate: targetDateParam ?? undefined,
      });
      results.push({ source_id: source.source_id, log: r.log });

      // 標記 first_scan_done
      if (!dryRun && !source.first_scan_done && r.log.scanned_count > 0 && r.log.error == null) {
        source.first_scan_done = true;
      }
    } catch (err) {
      const failLog: YouTubeSourceScanLog = {
        source_id: source.source_id,
        scan_date: scanDate,
        started_at: now.toISOString(),
        finished_at: new Date().toISOString(),
        scanned_count: 0,
        new_count: 0,
        analyzable_count: 0,
        skipped_count: 0,
        failed_count: 1,
        error: `exception: ${(err as Error).message}`,
        possible_missing_update: false,
        consecutive_empty_days: prevEmpty + 1,
      };
      results.push({ source_id: source.source_id, log: failLog });
    }
  }

  // 寫回 sources.json（更新 first_scan_done）
  if (!dryRun) {
    try {
      const allSources = await loadSources();
      const updated = allSources.map(s => {
        const touched = sources.find(x => x.source_id === s.source_id);
        return touched ?? s;
      });
      await saveSources(updated);
    } catch (err) {
      console.error('[youtube-scan] saveSources failed', err);
    }
  }

  // 重算 health.json
  if (!dryRun) {
    try {
      const allSources = await loadSources();
      const recentLogsAfter = await loadRecentScanLogs(scanDate, 14);
      const health = await buildHealthSnapshot(scanDate, allSources, recentLogsAfter);
      await saveHealth(health);
    } catch (err) {
      console.error('[youtube-scan] saveHealth failed', err);
    }
  }

  const allFailed = results.length > 0 && results.every(r => r.log.error != null);
  const status = allFailed ? 500 : 200;

  return apiOk({
    scan_date: scanDate,
    dry_run: dryRun,
    sources_scanned: results.length,
    results: results.map(r => ({
      source_id: r.source_id,
      scanned: r.log.scanned_count,
      new: r.log.new_count,
      analyzable: r.log.analyzable_count,
      skipped: r.log.skipped_count,
      error: r.log.error,
      consecutive_empty_days: r.log.consecutive_empty_days,
      possible_missing_update: r.log.possible_missing_update,
    })),
  }, { status });
}

function computePrevEmptyDays(
  todayYmd: string,
  recentLogs: Map<string, YouTubeSourceScanLog[]>,
): Map<string, number> {
  // 取昨天日期
  const today = new Date(`${todayYmd}T00:00:00.000Z`);
  const yest = new Date(today.getTime() - 86400_000).toISOString().slice(0, 10);
  const yestLogs = recentLogs.get(yest) ?? [];
  const map = new Map<string, number>();
  for (const log of yestLogs) {
    map.set(log.source_id, log.consecutive_empty_days);
  }
  return map;
}

async function buildHealthSnapshot(
  scanDate: string,
  sources: YouTubeSource[],
  recentLogs: Map<string, YouTubeSourceScanLog[]>,
): Promise<YouTubeHealthSnapshot> {
  const todayLogs = new Map(
    (recentLogs.get(scanDate) ?? []).map(l => [l.source_id, l]),
  );

  // 依時間倒序找最近一次成功 + 最近一次發現影片
  const dates = Array.from(recentLogs.keys()).sort().reverse();

  const sourcesHealth: YouTubeSourceHealth[] = sources.map(source => {
    const today = todayLogs.get(source.source_id);
    let lastScanAt: string | null = null;
    let lastSuccessAt: string | null = null;
    let lastVideoDiscoveredAt: string | null = null;
    for (const d of dates) {
      const log = (recentLogs.get(d) ?? []).find(l => l.source_id === source.source_id);
      if (!log) continue;
      if (lastScanAt == null) lastScanAt = log.finished_at ?? log.started_at;
      // last_success_at:scan run 完成且無錯誤 — 注意「scan 成功」≠「有抓到新節目」
      if (lastSuccessAt == null && log.error == null) lastSuccessAt = log.finished_at ?? log.started_at;
      // 2026-05-25 修:last_video_discovered_at 改用 analyzable_count(實際當日 program_date 新節目)
      // 之前用 scanned_count > 0(playlist 撈到任何影片即算)會讓 user 誤以為「有抓到」但下方影片列表卻沒有
      if (lastVideoDiscoveredAt == null && log.analyzable_count > 0) {
        lastVideoDiscoveredAt = log.finished_at ?? log.started_at;
      }
      if (lastScanAt && lastSuccessAt && lastVideoDiscoveredAt) break;
    }

    return {
      source_id: source.source_id,
      display_name: source.display_name,
      expected_cadence: source.expected_cadence,
      active: source.active,
      last_scan_at: lastScanAt,
      last_success_at: lastSuccessAt,
      last_video_discovered_at: lastVideoDiscoveredAt,
      consecutive_empty_days: today?.consecutive_empty_days ?? 0,
      possible_missing_update: today?.possible_missing_update ?? false,
      today: {
        scanned: today?.scanned_count ?? 0,
        analyzable: today?.analyzable_count ?? 0,
        skipped: today?.skipped_count ?? 0,
        failed: today?.failed_count ?? 0,
        error: today?.error ?? null,
      },
    };
  });

  return {
    generated_at: new Date().toISOString(),
    scan_date: scanDate,
    sources: sourcesHealth,
  };
}
