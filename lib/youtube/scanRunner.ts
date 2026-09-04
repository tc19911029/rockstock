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
  effectiveProgramDate,
  parseProgramDate,
  clampProgramDateToPublish,
  todayYmdTaipei,
  videoConfidenceScore,
} from './classify';
import { resolveAnalystsForVideo } from './analystParser';
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

/**
 * 防呆：所有 source 必須是合法 playlist URL（`youtube.com/playlist?list=PL...`）。
 * channel URL（`/@xxx/videos`）會把整個頻道的影片都抓進來 — 包括我們不想要的
 * 短切、精華片段、業配等。歷史上 sources.json 曾經被改成 channel URL 導致誤抓
 * （例：錢線百分百的 part 1-10 短片不在 playlist 內但會跟著 channel 一起出現）。
 * scan 前先擋掉，不對的直接 throw，scan log 會記 error 給前端紅燈。
 */
function assertPlaylistUrl(source: YouTubeSource): void {
  if (source.kind === 'playlist') {
    // 接受 PL (人工 playlist) 或 UU (channel uploads — 自動把所有影片放一起)
    // 不接受 LL (liked, user only) / FL (deprecated) / RD (auto radio)
    if (!/^https:\/\/www\.youtube\.com\/playlist\?list=(PL|UU)[A-Za-z0-9_-]+/.test(source.url)) {
      throw new Error(
        `source "${source.source_id}" kind=playlist but URL is not a PL/UU playlist URL: ${source.url}`,
      );
    }
  } else if (source.kind === 'channel') {
    // kind=channel 仍不支援（會帶 /@xxx/videos 等 URL，yt-dlp 行為不一致）。
    // 想抓整頻道？用 uploads playlist：UU + channel_id_without_UC_prefix
    throw new Error(
      `source "${source.source_id}" kind=channel not supported; use uploads playlist URL ` +
      `(https://www.youtube.com/playlist?list=UU{channel_id})`,
    );
  }
}

/** 主要 orchestration：對單一來源跑一次 scan，回傳 log + videos。 */
export async function scanOneSource(opts: ScanOneOptions): Promise<ScanOneResult> {
  const { source, now } = opts;
  assertPlaylistUrl(source);
  const limit = source.first_scan_done ? REGULAR_SCAN_LIMIT : FIRST_SCAN_LIMIT;
  const scanDate = todayYmdTaipei(now);
  const startedAt = now.toISOString();

  const result = await fetchRecentVideos(source.url, { limit, ...(opts.fetchOptions || {}) });

  // 抓到的影片轉成 YouTubeVideo
  const videoIndex = opts.dryRun ? { byId: {}, updated_at: '' } : await loadVideoIndex();
  const transformed: YouTubeVideo[] = result.videos.map(raw => {
    const videoType = classifyVideoType(raw);
    const publishedAt = uploadDateToIso(raw.upload_date, raw.timestamp);
    // 防未來日誤判：標題裡的日期若晚於上傳日（例：「台積電7/16法說」把法說會日期
    // 當成節目日，整集被丟到未來檔）→ 退回 published_at 推算的台灣日。
    const programDate = clampProgramDateToPublish(parseProgramDate(raw.title, now), publishedAt);
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
      analysts: resolveAnalystsForVideo(raw.title, source.default_analysts, source.display_name),
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
    // 寫入 videos 按「節目日期」分檔（program_date 優先，沒有的退回 published_at；
    // 兩者都沒才用 scanDate）。標題裡的日期是真實節目日 — 晚間節目常常隔天 00:xx
    // 才 upload 完，published_at 會掉到隔天，按 published_at 分檔會錯位。
    // live_replay 的 published_at 在 replay 定型後會被 yt-dlp 改成「replay 完成時間」，
    // 這個時間經常掉到隔天凌晨（例如 21:09 live 開始 → 隔天 05:04 才 was_live 化），
    // 會讓影片從原本的 fileDate 漂到隔天。對於已知影片 + live_status=was_live，
    // 直接沿用 video-index 內第一次入帳的 fileDate，不重算。
    const fileDateOf = (v: YouTubeVideo): string => {
      const known = videoIndex.byId[v.video_id];
      const isWasLive = v.raw?.live_status === 'was_live';
      if (known && isWasLive) return known.date;
      return effectiveProgramDate(v) ?? scanDate;
    };

    const byFileDate = new Map<string, YouTubeVideo[]>();
    for (const v of transformed) {
      const fileDate = fileDateOf(v);
      const arr = byFileDate.get(fileDate) ?? [];
      arr.push(v);
      byFileDate.set(fileDate, arr);
    }
    for (const [fileDate, vids] of byFileDate.entries()) {
      await mergeVideosForDate(fileDate, vids);
    }

    // 更新 video-index：key=video_id，value 的 date 用該 video 的 fileDate
    const updatedIndex: VideoIndex = {
      byId: { ...videoIndex.byId },
      updated_at: new Date().toISOString(),
    };
    for (const v of newVideos) {
      updatedIndex.byId[v.video_id] = { date: fileDateOf(v), source_id: source.source_id };
    }
    await saveVideoIndex(updatedIndex);

    // 寫入 scan log（scan-log 仍以 scanDate 為主檔 key，因為它記錄 scan 行為而非影片內容）
    await upsertScanLog(scanDate, log);
  }

  return { log, newVideos, allVideos: transformed };
}
