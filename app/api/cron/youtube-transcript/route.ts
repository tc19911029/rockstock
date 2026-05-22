/**
 * POST /api/cron/youtube-transcript
 *
 * 抓取今日 should_analyze=true 影片的字幕、評分、寫盤。
 * 必須在 youtube-scan 跑完後才有意義 — launchd 排在 22:30 / 09:30 CST。
 *
 * Query:
 *   ?date=YYYY-MM-DD    指定日期（預設今日 Asia/Taipei）
 *   ?source_id=...      只跑單一來源
 *   ?video_id=...       只跑單一影片
 *   ?force=1            跳過「已抓過」快取（演算法調整時重算用）
 *   ?dry_run=1          不寫盤
 */

import { NextRequest } from 'next/server';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { fetchTranscript, parseVtt } from '@/lib/youtube/transcript';
import { gradeTranscript } from '@/lib/youtube/transcriptQuality';
import { loadVideosForDate } from '@/lib/youtube/videoStorage';
import {
  loadTranscriptIndex,
  saveTranscript,
  saveTranscriptIndex,
} from '@/lib/youtube/transcriptStorage';
import type { TranscriptIndex, TranscriptRecord } from '@/lib/youtube/transcriptStorage';
import { readVttAndCleanup, transcribeViaWhisper } from '@/lib/youtube/whisper';
// 2026-05-22 15:38 — touched to force Next.js HMR pickup of whisper.ts DEFAULT_WHISPER_MODEL change

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) { return handle(req); }
export async function GET(req: NextRequest) { return handle(req); }

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayYmdTaipei(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError('date must be YYYY-MM-DD', 400);
  }
  const filterSourceId = url.searchParams.get('source_id');
  const filterVideoId = url.searchParams.get('video_id');
  const force = url.searchParams.get('force') === '1';
  const dryRun = url.searchParams.get('dry_run') === '1';
  const useWhisper = url.searchParams.get('use_whisper') === '1';   // 字幕抓不到時走 Whisper 補

  const videos = await loadVideosForDate(date);
  const candidates = videos.filter(v =>
    v.should_analyze &&
    (!filterSourceId || v.source_id === filterSourceId) &&
    (!filterVideoId || v.video_id === filterVideoId)
  );

  if (candidates.length === 0) {
    return apiOk({
      date, candidates: 0, processed: 0,
      message: 'no analyzable videos for this date / filter',
    });
  }

  // 載入既有 index，決定哪些跳過
  const index = await loadTranscriptIndex();

  const results: Array<{
    video_id: string; source_id: string; status: string;
    quality_score: number; lang: string | null; char_count: number;
    skipped: boolean; error: string | null; whisper_used?: boolean;
  }> = [];

  for (const video of candidates) {
    const existing = index.byId[video.video_id];
    // 已抓過且非 force：跳過 (status 不影響 — 即使 unavailable 也認定 sticky，避免每次重撞 YouTube)
    // 例外：existing.status=unavailable/failed 且本次 use_whisper=1 → 重試（Whisper 可能補回來）
    const retryWithWhisper = useWhisper && existing && (existing.status === 'unavailable' || existing.status === 'failed');
    if (existing && !force && !retryWithWhisper) {
      results.push({
        video_id: video.video_id, source_id: video.source_id,
        status: existing.status, quality_score: existing.quality_score,
        lang: existing.lang, char_count: existing.char_count,
        skipped: true, error: null,
      });
      continue;
    }

    let fetchResult;
    let whisperUsed = false;
    let whisperError: string | null = null;
    try {
      fetchResult = await fetchTranscript({
        videoUrl: video.url,
        manualOnly: true,           // 決議 A：只接受人工字幕（避開自動字幕錯亂）
      });
      // Fallback: 拿不到人工字幕且 use_whisper=1 → 走 Whisper
      if (!fetchResult.available && useWhisper) {
        const w = await transcribeViaWhisper({ videoUrl: video.url });
        if (w.ok && w.vttPath) {
          const vttRaw = await readVttAndCleanup(w.vttPath);
          const parsed = parseVtt(vttRaw);
          fetchResult = {
            available: true,
            manual: false,            // Whisper 不是人工，但品質夠
            lang: 'zh',
            text: parsed.text,
            cues: parsed.cues,
            char_count: parsed.text.length,
            vtt_bytes: Buffer.byteLength(vttRaw, 'utf-8'),
            stderr: 'via whisper: ' + (w.stderr.trim().slice(-200) || 'ok'),
            exit_code: 0,
            timed_out: false,
          };
          whisperUsed = true;
        } else {
          whisperError = `whisper fallback failed: ${w.stderr.trim().slice(-400) || `exit ${w.exitCode}`}`;
        }
      }
    } catch (err) {
      results.push({
        video_id: video.video_id, source_id: video.source_id,
        status: 'failed', quality_score: 0, lang: null, char_count: 0,
        skipped: false, error: `exception: ${(err as Error).message}`,
      });
      continue;
    }

    const grade = gradeTranscript({ fetched: fetchResult, title: video.title });

    const record: TranscriptRecord = {
      video_id: video.video_id,
      source_id: video.source_id,
      date,
      fetched_at: new Date().toISOString(),
      status: grade.status,
      quality_score: grade.score,
      lang: fetchResult.lang,
      char_count: fetchResult.char_count,
      cue_count: fetchResult.cues.length,
      vtt_bytes: fetchResult.vtt_bytes,
      text: fetchResult.text,
      cues: fetchResult.cues,
      error: whisperError
        ? whisperError
        : (fetchResult.timed_out
            ? 'timeout'
            : (fetchResult.exit_code !== 0 && fetchResult.exit_code !== null
                ? fetchResult.stderr.trim().slice(-500) || `exit ${fetchResult.exit_code}`
                : null)),
      quality: {
        lang_ok: grade.lang_ok,
        length_ok: grade.length_ok,
        has_timestamps: grade.has_timestamps,
        stock_keyword_hits: grade.stock_keyword_hits,
        rolling_dup_ratio: grade.rolling_dup_ratio,
      },
    };

    if (!dryRun) {
      try {
        await saveTranscript(record);
        index.byId[video.video_id] = {
          status: record.status,
          quality_score: record.quality_score,
          lang: record.lang,
          char_count: record.char_count,
          fetched_at: record.fetched_at,
          date: record.date,
        };
        // 增量寫 index：避免長 Whisper backfill 中斷時 index 落後（之前 bug：迴圈外才寫一次）
        index.updated_at = new Date().toISOString();
        await saveTranscriptIndex(index);
      } catch (err) {
        record.error = `save failed: ${(err as Error).message}`;
      }
    }

    results.push({
      video_id: video.video_id, source_id: video.source_id,
      status: record.status, quality_score: record.quality_score,
      lang: record.lang, char_count: record.char_count,
      skipped: false, error: record.error, whisper_used: whisperUsed,
    });
  }

  if (!dryRun) {
    try {
      index.updated_at = new Date().toISOString();
      await saveTranscriptIndex(index);
    } catch (err) {
      console.error('[youtube-transcript] saveIndex failed', err);
    }
  }

  // 統計
  const stats = {
    candidates: candidates.length,
    processed: results.filter(r => !r.skipped).length,
    available: results.filter(r => r.status === 'available').length,
    low_quality: results.filter(r => r.status === 'low_quality').length,
    unavailable: results.filter(r => r.status === 'unavailable').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.skipped).length,
  };

  return apiOk({ date, dry_run: dryRun, stats, results });
}
