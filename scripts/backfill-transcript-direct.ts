/**
 * 繞過 dev server HTTP route，直接呼叫 transcribeViaWhisper。
 *
 * 為什麼：dev server 在處理長 Whisper 後 response flush 前 OOM kill；
 *        透過 HTTP 永遠拿不到結果。直接 tsx 跑 = 不過 server，記憶體佔用減半，可靠。
 *
 * Usage:
 *   npx tsx scripts/backfill-transcript-direct.ts 2026-05-22         (整日)
 *   npx tsx scripts/backfill-transcript-direct.ts 2026-05-22 video_id1 video_id2 ...
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fetchTranscript, parseVtt } from '../lib/youtube/transcript';
import { transcribeViaWhisper, readVttAndCleanup } from '../lib/youtube/whisper';
import { gradeTranscript } from '../lib/youtube/transcriptQuality';
import type { YouTubeVideo } from '../lib/youtube/types';

const ROOT = path.join(process.cwd(), 'data', 'youtube');

interface TranscriptRecord {
  video_id: string;
  source_id: string;
  date: string;
  fetched_at: string;
  status: string;
  quality_score: number;
  lang: string | null;
  char_count: number;
  cue_count: number;
  vtt_bytes: number;
  text: string;
  cues: unknown[];
  error: string | null;
  quality: Record<string, unknown>;
}

async function main() {
  const date = process.argv[2];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('Usage: tsx scripts/backfill-transcript-direct.ts YYYY-MM-DD [video_id ...]');
    process.exit(1);
  }
  const filterVids = new Set(process.argv.slice(3));

  // Load videos
  const videos: YouTubeVideo[] = JSON.parse(
    await fs.readFile(path.join(ROOT, 'videos', `${date}.json`), 'utf-8'),
  );

  // Load transcript-index to skip already-done
  const tIdxPath = path.join(ROOT, 'transcript-index.json');
  const tIdx: { byId: Record<string, unknown>; updated_at: string } =
    JSON.parse(await fs.readFile(tIdxPath, 'utf-8'));

  // Candidates: analyzable + not yet in index
  const candidates = videos.filter(v =>
    v.should_analyze &&
    !(v.video_id in tIdx.byId) &&
    (filterVids.size === 0 || filterVids.has(v.video_id)),
  );

  console.log(`Date ${date}: ${candidates.length} candidates to process`);

  for (const v of candidates) {
    console.log(`\n[${v.video_id}] ${v.source_id} - ${v.title.slice(0, 40)}`);
    const t0 = Date.now();

    let text = '';
    let cues: unknown[] = [];
    let lang: string | null = null;
    let charCount = 0;
    let vttBytes = 0;
    let usedWhisper = false;
    let error: string | null = null;

    try {
      // 1. yt-dlp 試人工字幕
      const f1 = await fetchTranscript({ videoUrl: v.url, manualOnly: true });
      if (f1.available) {
        text = f1.text;
        cues = f1.cues;
        lang = f1.lang;
        charCount = f1.char_count;
        vttBytes = f1.vtt_bytes;
        console.log(`  manual sub OK: ${charCount} chars, lang=${lang}`);
      } else {
        // 2. Whisper fallback
        console.log(`  no manual sub, fallback Whisper...`);
        const w = await transcribeViaWhisper({ videoUrl: v.url });
        if (w.ok && w.vttPath) {
          const vttRaw = await readVttAndCleanup(w.vttPath);
          const parsed = parseVtt(vttRaw);
          text = parsed.text;
          cues = parsed.cues;
          lang = 'zh';
          charCount = parsed.text.length;
          vttBytes = Buffer.byteLength(vttRaw, 'utf-8');
          usedWhisper = true;
          console.log(`  whisper OK: ${charCount} chars`);
        } else {
          error = `whisper failed: ${w.stderr.slice(-300)}`;
          console.log(`  whisper FAILED: ${error}`);
        }
      }
    } catch (e) {
      error = `exception: ${(e as Error).message}`;
      console.log(`  EXCEPTION: ${error}`);
    }

    const grade = gradeTranscript({
      fetched: {
        available: !error, manual: !usedWhisper, lang, text, cues: cues as never[],
        char_count: charCount, vtt_bytes: vttBytes,
        stderr: '', exit_code: error ? 1 : 0, timed_out: false,
      },
      title: v.title,
    });

    // 寫 transcript file
    const record: TranscriptRecord = {
      video_id: v.video_id, source_id: v.source_id, date,
      fetched_at: new Date().toISOString(),
      status: grade.status, quality_score: grade.score,
      lang, char_count: charCount, cue_count: cues.length, vtt_bytes: vttBytes,
      text, cues, error,
      quality: {
        lang_ok: grade.lang_ok,
        length_ok: grade.length_ok,
        has_timestamps: grade.has_timestamps,
        stock_keyword_hits: grade.stock_keyword_hits,
        rolling_dup_ratio: grade.rolling_dup_ratio,
      },
    };
    const dateDir = path.join(ROOT, 'transcripts', date);
    await fs.mkdir(dateDir, { recursive: true });
    await fs.writeFile(path.join(dateDir, `${v.video_id}.json`), JSON.stringify(record, null, 2));

    // 更新 index
    tIdx.byId[v.video_id] = {
      status: grade.status, quality_score: grade.score,
      lang, char_count: charCount,
      fetched_at: record.fetched_at, date,
    };
    tIdx.updated_at = new Date().toISOString();
    await fs.writeFile(tIdxPath, JSON.stringify(tIdx, null, 2));

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ✓ wrote transcript (${dt}s, status=${grade.status}, q=${grade.score})`);
  }
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
