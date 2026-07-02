/**
 * 一次性：把手動跑好的 VTT 灌進 transcript 儲存（鏡像 youtube-transcript route 的存檔邏輯）。
 * 用於長影片 Whisper 在 cron 內崩潰、改在外面跑好 VTT 後補入。
 *
 * 用法: npx tsx scripts/ingest-vtt-once.ts <vttPath> <video_id> <source_id> <date> [lang]
 */
import { readFileSync } from 'node:fs';
import { parseVtt } from '../lib/youtube/transcript';
import { gradeTranscript } from '../lib/youtube/transcriptQuality';
import {
  saveTranscript, loadTranscriptIndex, saveTranscriptIndex,
} from '../lib/youtube/transcriptStorage';
import type { TranscriptRecord } from '../lib/youtube/transcriptStorage';

async function main() {
  const [vttPath, videoId, sourceId, date, lang = 'zh'] = process.argv.slice(2);
  if (!vttPath || !videoId || !sourceId || !date) {
    console.error('usage: ingest-vtt-once.ts <vttPath> <video_id> <source_id> <date> [lang]');
    process.exit(1);
  }
  const vttRaw = readFileSync(vttPath, 'utf-8');
  const parsed = parseVtt(vttRaw);

  const fetched = {
    available: true,
    manual: false,            // Whisper 不是人工，但品質夠（同 route 慣例）
    lang,
    text: parsed.text,
    cues: parsed.cues,
    char_count: parsed.text.length,
    vtt_bytes: Buffer.byteLength(vttRaw, 'utf-8'),
    stderr: 'via whisper (manual full-length run, m4a→16k wav)',
    exit_code: 0,
    timed_out: false,
  };

  // 需要 title 算品質的股名命中 — 用標題佔位（不影響 available 判定）
  const grade = gradeTranscript({ fetched, title: `${date}股市全芳位` });

  const record: TranscriptRecord = {
    video_id: videoId,
    source_id: sourceId,
    date,
    fetched_at: new Date().toISOString(),
    status: grade.status,
    quality_score: grade.score,
    lang: fetched.lang,
    char_count: fetched.char_count,
    cue_count: fetched.cues.length,
    vtt_bytes: fetched.vtt_bytes,
    text: fetched.text,
    cues: fetched.cues,
    error: null,
    quality: {
      lang_ok: grade.lang_ok,
      length_ok: grade.length_ok,
      has_timestamps: grade.has_timestamps,
      stock_keyword_hits: grade.stock_keyword_hits,
      rolling_dup_ratio: grade.rolling_dup_ratio,
    },
  };

  await saveTranscript(record);
  const index = await loadTranscriptIndex();
  index.byId[videoId] = {
    status: record.status,
    quality_score: record.quality_score,
    lang: record.lang,
    char_count: record.char_count,
    fetched_at: record.fetched_at,
    date: record.date,
  };
  index.updated_at = new Date().toISOString();
  await saveTranscriptIndex(index);

  console.log(JSON.stringify({
    ok: true, video_id: videoId, status: record.status,
    quality_score: record.quality_score, cue_count: record.cue_count,
    char_count: record.char_count,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
