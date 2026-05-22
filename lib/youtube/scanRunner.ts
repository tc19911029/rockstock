/**
 * Scan orchestration（從 API route 抽出，方便測試）。
 *
 * 流程：
 *   1) 對單一 source 呼叫 yt-dlp 抓最近 N 支
 *   2) 對每支 video classify + decide + score
 *   3) 用全域 video-index 判定新舊（dedup by video_id）
 *   4) merge 入當日 videos/{date}.json
 *   5) 回傳 scan log entry
 *
 * Caller 負責：
 *   - 序列跑每個 source
 *   - 重算 health.json
 *   - 寫回 sources.json（更新 first_scan_done）
 */

import {
  classifyVideoType,
  decideShouldAnalyze,
  parseProgramDate,
  todayYmdTaipei,
  ymdTaipei,
  videoConfidenceScore,
} from './classify';
import {
  loadVideoIndex,
  mergeVideosForDate,
  saveVideoIndex,
  upsertScanLog,
} from './videoStorage';
import { fetchRecentVideos, uploadDateToIso, type FetchOptions } from './ytdlp';
import type {
  VideoIndex,
  YouTubeSource,
  YouTubeSourceScanLog,
  YouTubeVideo,
} from './types';

// 2026-05-22：移除 --flat-playlist 後實測 ~1.1s/支。
// 6 來源 × 30 = ~200s（fits 300s budget），仍給首掃 10 支歷史 backfill 空間。
const FIRST_SCAN_LIMIT = 30;
const REGULAR_SCAN_LIMIT = 20;

export interface ScanOneOptions {
  source: YouTubeSource;
  now: Date;
  dryRun?: boolean;
  fetchOptions?: FetchOptions;
  /** previous consecutive_empty_days for this source — caller looks up from yesterday's log */
  prevConsecutiveEmptyDays?: number;
  /**
   * 嚴格同日過濾：published_at 必須落在此日期 (Asia/Taipei YYYY-MM-DD)。
   * 不提供時退回 72h 窗（向下相容）。
   * 用於 backfill：?date=2026-05-21 只挑 5/21 當天上傳的影片。
   */
  targetDate?: string;
}

export interface ScanOneResult {
  log: YouTubeSourceScanLog;
  /** 該來源在本次 scan 中新發現的 video（之前 index 沒有） */
  newVideos: YouTubeVideo[];
  /** 本次 scan 看到的所有（含已知）— 用於 merge 當日 videos */
  allVideos: YouTubeVideo[];
}

/** 主要 orchestration：對單一來源跑一次 scan，回傳 log + videos。 */
export async function scanOneSource(opts: ScanOneOptions): Promise<ScanOneResult> {
  const { source, now } = opts;
  const limit = source.first_scan_done ? REGULAR_SCAN_LIMIT : FIRST_SCAN_LIMIT;
  const scanDate = todayYmdTaipei(now);
  const startedAt = now.toISOString();

  const result = await fetchRecentVideos(source.url, { limit, ...(opts.fetchOptions || {}) });

  // 抓到的影片轉成 YouTubeVideo
  const videoIndex = opts.dryRun ? { byId: {}, updated_at: '' } : await loadVideoIndex();
  const transformed: YouTubeVideo[] = result.videos.map(raw => {
    const videoType = classifyVideoType(raw);
    const publishedAt = uploadDateToIso(raw.upload_date, raw.timestamp);
    const programDate = parseProgramDate(raw.title, now);
    const known = videoIndex.byId[raw.id];
    const discovered_at = known ? '' : startedAt; // 真正值在下方 patch

    const tempVideo: YouTubeVideo = {
      video_id: raw.id,
      source_id: source.source_id,
      title: raw.title,
      url: raw.url,
      duration_sec: raw.duration ?? null,
      published_at: publishedAt,
      program_date: programDate,
      video_type: videoType,
      should_analyze: false,
      skip_reason: null,
      video_confidence_score: 0,
      discovered_at,
      last_seen_at: startedAt,
      raw: {
        live_status: raw.live_status ?? undefined,
        view_count: raw.view_count ?? undefined,
        channel_id: raw.channel_id,
      },
    };

    // 首次掃描（!first_scan_done）超過 20 支以外的 → historical backfill，不分析
    const alreadyAnalyzed = new Set<string>(); // MVP 1 沒有分析環節，這個集合始終空
    const decision = decideShouldAnalyze(tempVideo, {
      now, alreadyAnalyzed,
      targetDate: opts.targetDate,
    });
    tempVideo.should_analyze = decision.should;
    tempVideo.skip_reason = decision.reason;
    tempVideo.video_confidence_score = videoConfidenceScore(tempVideo, source, now);

    return tempVideo;
  });

  // 對首掃時的「歷史 backfill」標記（超過 REGULAR_SCAN_LIMIT 之後的視為 backfill）
  if (!source.first_scan_done) {
    transformed.forEach((v, idx) => {
      if (idx >= REGULAR_SCAN_LIMIT && v.should_analyze) {
        v.should_analyze = false;
        v.skip_reason = 'historical_backfill';
      }
    });
  }

  // dedup：新 vs 已知
  const newVideos: YouTubeVideo[] = [];
  for (const v of transformed) {
    const known = videoIndex.byId[v.video_id];
    if (!known) {
      v.discovered_at = startedAt;
      newVideos.push(v);
    } else {
      // 已知影片：discovered_at 保留先前值，但這裡我們不從 index 拿（index 只記 date+source）
      // 真正的 discovered_at 在 videos/{originalDate}.json 中。merge 流程不會覆蓋它。
      v.discovered_at = startedAt; // 預設值；mergeVideosForDate 會保留舊的 discovered_at
    }
  }

  const failed = result.exitCode !== 0;
  const analyzable = transformed.filter(v => v.should_analyze).length;
  const skipped = transformed.length - analyzable;
  const errorMsg = failed
    ? (result.timedOut ? 'timeout' : (result.stderr.trim().slice(-500) || `exit ${result.exitCode}`))
    : null;

  const isEmpty = transformed.length === 0;
  const consecutiveEmpty = isEmpty
    ? (opts.prevConsecutiveEmptyDays ?? 0) + 1
    : 0;
  const expectsDaily = source.expected_cadence === 'daily';
  const possibleMissingUpdate = expectsDaily && consecutiveEmpty >= 2;

  const log: YouTubeSourceScanLog = {
    source_id: source.source_id,
    scan_date: scanDate,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    scanned_count: transformed.length,
    new_count: newVideos.length,
    analyzable_count: analyzable,
    skipped_count: skipped,
    failed_count: failed ? 1 : 0,
    error: errorMsg,
    possible_missing_update: possibleMissingUpdate,
    consecutive_empty_days: consecutiveEmpty,
  };

  if (!opts.dryRun) {
    // 寫入 videos 按 published_at 日期分檔（避免跨日污染）
    // 沒 published_at 的歸到 scanDate file
    const byPubDate = new Map<string, YouTubeVideo[]>();
    for (const v of transformed) {
      const pubDate = v.published_at ? ymdTaipei(new Date(v.published_at)) : scanDate;
      const arr = byPubDate.get(pubDate) ?? [];
      arr.push(v);
      byPubDate.set(pubDate, arr);
    }
    for (const [pubDate, vids] of byPubDate.entries()) {
      await mergeVideosForDate(pubDate, vids);
    }

    // 更新 video-index：key=video_id，value 的 date 用該 video 的 pubDate（不是 scanDate）
    const updatedIndex: VideoIndex = {
      byId: { ...videoIndex.byId },
      updated_at: new Date().toISOString(),
    };
    for (const v of newVideos) {
      const pubDate = v.published_at ? ymdTaipei(new Date(v.published_at)) : scanDate;
      updatedIndex.byId[v.video_id] = { date: pubDate, source_id: source.source_id };
    }
    await saveVideoIndex(updatedIndex);

    // 寫入 scan log（scan-log 仍以 scanDate 為主檔 key，因為它記錄 scan 行為而非影片內容）
    await upsertScanLog(scanDate, log);
  }

  return { log, newVideos, allVideos: transformed };
}
