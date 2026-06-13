/**
 * 關鍵幀抽取 orchestrator — 每影片：下載(≤720p 純視訊) → ffmpeg 場景偵測抽幀
 * → 即刪影片 → python(dHash 去重 + Vision OCR) → TS 初篩 → WebP 壓縮保留。
 *
 * 沿用 whisper.ts 慣例：mkdtemp 工作目錄、spawn 包 timeout、module-level mutex
 * （避免 hourly cron 重疊時兩支影片同時下載/解碼把機器打爆）。
 *
 * 下載策略（計畫 B 決議）：yt-dlp 抓檔到 temp 而非 ffmpeg 直讀串流 —
 * googlevideo URL 對非 yt-dlp client 有 n-sig 限速、URL 會過期、proxy 不可重用。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { ytdlpProxyArgs } from './ytdlp';
import type { YouTubeVideo } from './types';
import { loadStockMaster } from './stockMaster';
import { buildScreenMaster, scoreFrame, screenFrame } from './keyframeScreen';
import {
  keyframeImageDir, keyframeRawDir, type KeyframeMeta, type KeyframeRecord,
} from './keyframeStorage';

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const OCR_SCRIPT = path.join(process.cwd(), 'scripts', 'keyframe-ocr.py');

/** 場景變化閾值（單支 E2E 驗證後可調 0.25/0.30/0.35） */
const SCENE_THRESHOLD = Number(process.env.KEYFRAME_SCENE_THRESHOLD || 0.30);
/** 下載解析度上限（720p OCR 不夠清晰的來源可升 1080） */
const MAX_HEIGHT = Number(process.env.KEYFRAME_MAX_HEIGHT || 720);
/** 超過 3 小時的影片不抽（直播回放動輒 4-6h，下載/解碼成本爆炸） */
const MAX_DURATION_SEC = 10_800;
/** ffmpeg 場景幀上限（快剪片頭防爆；超過取 scene_score 最高的） */
const MAX_SCENE_FRAMES = 400;

function augmentedPath(): string {
  const extras = [`${homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin'];
  return [...extras, process.env.PATH || ''].filter(Boolean).join(':');
}

async function spawnAwait(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string },
): Promise<{ exitCode: number | null; stderr: string; stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, PATH: augmentedPath() } });
    } catch (err) {
      resolve({ exitCode: null, stderr: `spawn failed: ${(err as Error).message}`, stdout: '', timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3_000);
    }, opts.timeoutMs);

    child.stdout?.setEncoding?.('utf-8');
    child.stdout?.on('data', (c: string) => {
      stdoutBuf += c;
      if (stdoutBuf.length > 8 * 1024 * 1024) stdoutBuf = stdoutBuf.slice(-4 * 1024 * 1024);
    });
    child.stderr?.setEncoding?.('utf-8');
    child.stderr?.on('data', (c: string) => {
      stderrBuf += c;
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-32 * 1024);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stderr: `${stderrBuf}\nerror: ${err.message}`, stdout: stdoutBuf, timedOut });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stderr: stderrBuf, stdout: stdoutBuf, timedOut });
    });
  });
}

// ── Mutex：全程序同時只抽 1 支（下載頻寬 + ffmpeg 解碼 + Vision 都吃資源） ──
let keyframeLock: Promise<void> = Promise.resolve();
async function acquireLock(): Promise<() => void> {
  const prev = keyframeLock;
  let release!: () => void;
  keyframeLock = new Promise<void>((resolve) => { release = resolve; });
  await prev;
  return release;
}

interface SceneFrame { file: string; ts: number; score: number }

/** 解析 metadata=print:file= 的輸出（frame:N pts_time:X / lavfi.scene_score=Y 區塊） */
export function parseScenesFile(content: string): SceneFrame[] {
  const out: SceneFrame[] = [];
  let current: { ts: number | null; score: number } | null = null;
  let n = 0;
  for (const line of content.split('\n')) {
    const frameMatch = line.match(/^frame:\d+\s+.*pts_time:([\d.]+)/);
    if (frameMatch) {
      if (current && current.ts != null) {
        n += 1;
        out.push({ file: `${String(n).padStart(6, '0')}.jpg`, ts: current.ts, score: current.score });
      }
      current = { ts: Number(frameMatch[1]), score: 0 };
      continue;
    }
    const scoreMatch = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (scoreMatch && current) current.score = Number(scoreMatch[1]);
  }
  if (current && current.ts != null) {
    n += 1;
    out.push({ file: `${String(n).padStart(6, '0')}.jpg`, ts: current.ts, score: current.score });
  }
  return out;
}

interface OcrLine {
  file: string;
  ts: number;
  dhash?: string;
  ocr_text?: string;
  ocr_confidence?: number;
  block_count?: number;
  dropped?: string;
}

export interface ExtractKeyframesOptions {
  /** 該影片逐字稿全文（scoreFrame novel 判定用）；無逐字稿傳 '' */
  transcriptText?: string;
}

/**
 * 對單支影片跑完整關鍵幀抽取，回傳 KeyframeRecord（caller 負責持久化）。
 * 受 module mutex 保護：多 caller 自動排隊。
 */
export async function extractKeyframes(
  video: YouTubeVideo,
  date: string,
  opts: ExtractKeyframesOptions = {},
): Promise<KeyframeRecord> {
  const release = await acquireLock();
  try {
    return await extractKeyframesUnsafe(video, date, opts);
  } finally {
    release();
  }
}

function baseRecord(video: YouTubeVideo, date: string): KeyframeRecord {
  return {
    video_id: video.video_id,
    source_id: video.source_id,
    date,
    extracted_at: new Date().toISOString(),
    status: 'failed',
    video_height: null,
    scene_threshold: SCENE_THRESHOLD,
    frames_extracted: 0,
    frames_after_dedup: 0,
    frames_kept: 0,
    error: null,
    timings: { download_ms: 0, extract_ms: 0, ocr_ms: 0 },
    frames: [],
  };
}

async function extractKeyframesUnsafe(
  video: YouTubeVideo,
  date: string,
  opts: ExtractKeyframesOptions,
): Promise<KeyframeRecord> {
  const record = baseRecord(video, date);

  if ((video.duration_sec ?? 0) > MAX_DURATION_SEC) {
    record.status = 'skipped_too_long';
    record.error = `duration ${video.duration_sec}s > ${MAX_DURATION_SEC}s`;
    return record;
  }

  const work = await fs.mkdtemp(path.join(tmpdir(), 'yt-keyframe-'));
  const framesDir = path.join(work, 'frames');
  await fs.mkdir(framesDir, { recursive: true });

  try {
    // 1) 下載 ≤MAX_HEIGHT 純視訊流（無聲；mp4 優先，fallback 任意容器）
    const t0 = Date.now();
    const dlArgs = [
      '-f', `bv*[height<=${MAX_HEIGHT}][ext=mp4]/bv*[height<=${MAX_HEIGHT}]/bv*`,
      '--no-warnings', '--ignore-config',
      ...(await ytdlpProxyArgs()),
      '-o', path.join(work, 'video.%(ext)s'),
      video.url,
    ];
    const dl = await spawnAwait(YTDLP_BIN, dlArgs, { timeoutMs: 480_000 });
    record.timings.download_ms = Date.now() - t0;

    const workFiles = await fs.readdir(work);
    const videoFile = workFiles.find(f => f.startsWith('video.'));
    if (dl.exitCode !== 0 || !videoFile) {
      record.status = 'no_video';
      record.error = `yt-dlp download failed: ${dl.stderr.slice(-400)}`;
      return record;
    }
    const videoPath = path.join(work, videoFile);

    // 2) ffmpeg 場景偵測抽幀（min-gap 4s 防快剪、120s 保底幀、30s bootstrap 防全靜態 0 幀）
    const t1 = Date.now();
    const scenesPath = path.join(work, 'scenes.txt');
    const selectExpr =
      `gt(scene,${SCENE_THRESHOLD})*(isnan(prev_selected_t)+gte(t-prev_selected_t,4))` +
      `+gte(t-prev_selected_t,120)+isnan(prev_selected_t)*gte(t,30)`;
    const vf = `select='${selectExpr}',metadata=print:file=${scenesPath},scale='min(1280,iw)':-2`;
    const ffArgsBase = [
      '-hide_banner', '-nostdin',
      '-i', videoPath,
      '-vf', vf,
      '-fps_mode', 'vfr', '-q:v', '3',
      path.join(framesDir, '%06d.jpg'),
    ];
    let ff = await spawnAwait(FFMPEG_BIN, ['-hwaccel', 'videotoolbox', ...ffArgsBase], { timeoutMs: 900_000 });
    if (ff.exitCode !== 0) {
      // videotoolbox 偶發不相容 → 純軟解重試一次
      await fs.rm(scenesPath, { force: true }).catch(() => undefined);
      ff = await spawnAwait(FFMPEG_BIN, ffArgsBase, { timeoutMs: 900_000 });
    }
    record.timings.extract_ms = Date.now() - t1;

    // 實際解析度（OCR 品質追蹤）
    const heightMatch = ff.stderr.match(/, (\d{3,4})x(\d{3,4})[ ,]/);
    record.video_height = heightMatch ? Number(heightMatch[2]) : null;

    // 影片用完即刪（磁碟回收，計畫決議不保留）
    await fs.rm(videoPath, { force: true }).catch(() => undefined);

    if (ff.exitCode !== 0) {
      record.error = `ffmpeg failed: ${ff.stderr.slice(-400)}`;
      return record;
    }

    let scenes = parseScenesFile(await fs.readFile(scenesPath, 'utf-8').catch(() => ''));
    record.frames_extracted = scenes.length;
    if (scenes.length === 0) {
      record.status = 'ok';   // 真的全靜態（少見）：空結果不是錯
      return record;
    }
    if (scenes.length > MAX_SCENE_FRAMES) {
      const keepFiles = new Set(
        [...scenes].sort((a, b) => b.score - a.score).slice(0, MAX_SCENE_FRAMES).map(s => s.file),
      );
      scenes = scenes.filter(s => keepFiles.has(s.file));
    }

    // 3) 留 raw jpg（10 天清理窗，OCR 失敗可 force 重跑）
    const rawDir = path.join(process.cwd(), keyframeRawDir(date, video.video_id));
    await fs.mkdir(rawDir, { recursive: true });
    for (const s of scenes) {
      await fs.copyFile(path.join(framesDir, s.file), path.join(rawDir, s.file)).catch(() => undefined);
    }

    // 4) python：dHash 去重 + Vision OCR
    const t2 = Date.now();
    const scenesJson = path.join(work, 'scenes.json');
    await fs.writeFile(scenesJson, JSON.stringify(scenes), 'utf-8');
    const ocr = await spawnAwait(PYTHON_BIN, [OCR_SCRIPT, 'analyze', framesDir, scenesJson], {
      timeoutMs: 600_000,
    });
    record.timings.ocr_ms = Date.now() - t2;

    if (ocr.exitCode === 3) {
      record.status = 'ocr_unavailable';
      record.error = `Vision OCR 不可用: ${ocr.stderr.slice(-300)}`;
      return record;
    }
    if (ocr.exitCode !== 0) {
      record.error = `keyframe-ocr analyze failed: ${ocr.stderr.slice(-400)}`;
      return record;
    }

    const ocrLines: OcrLine[] = [];
    for (const line of ocr.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { ocrLines.push(JSON.parse(trimmed)); } catch { /* 忽略非 JSON 行 */ }
    }
    const survivors = ocrLines.filter(l => !l.dropped);
    record.frames_after_dedup = survivors.length;

    // 5) TS 初篩 + 評分
    const master = await loadStockMaster();
    const sm = buildScreenMaster(master);
    const transcriptText = opts.transcriptText ?? '';
    const keptMetas: Array<KeyframeMeta & { srcFile: string }> = [];
    for (const l of survivors) {
      const text = l.ocr_text ?? '';
      const screen = screenFrame(text, sm);
      if (!screen.keep) continue;
      const score = scoreFrame({
        ocr_text: text,
        ocr_confidence: l.ocr_confidence ?? 0,
        hit_codes: screen.hit_codes,
        hit_names: screen.hit_names,
        hit_reasons: screen.hit_reasons,
      }, transcriptText);
      const tsRounded = Math.round(l.ts);
      // 永久 webp 只給「有代號/股名命中」的幀（純關鍵字幀留 OCR 文字即可，控制儲存量）
      const exportImage = screen.hit_codes.length > 0 || screen.hit_names.length > 0;
      keptMetas.push({
        srcFile: l.file,
        ts: l.ts,
        file: exportImage
          ? path.join(keyframeImageDir(date, video.video_id), `f${String(tsRounded).padStart(6, '0')}.webp`)
          : null,
        dhash: l.dhash ?? '',
        ocr_text: text,
        ocr_confidence: l.ocr_confidence ?? 0,
        hit_reasons: screen.hit_reasons,
        hit_codes: screen.hit_codes,
        hit_names: screen.hit_names,
        score,
      });
    }

    // 6) WebP 壓縮保留幀（只壓有存圖價值的）
    const exportMetas = keptMetas.filter(m => m.file != null);
    if (exportMetas.length > 0) {
      const jobs = exportMetas.map(m => ({
        src: path.join(framesDir, m.srcFile),
        dst: path.join(process.cwd(), m.file!),
      }));
      const jobsJson = path.join(work, 'webp-jobs.json');
      await fs.writeFile(jobsJson, JSON.stringify(jobs), 'utf-8');
      const webp = await spawnAwait(PYTHON_BIN, [OCR_SCRIPT, 'export-webp', jobsJson], { timeoutMs: 180_000 });
      if (webp.exitCode !== 0) {
        record.error = `export-webp failed: ${webp.stderr.slice(-300)}`;
        // 圖片輸出失敗不整筆作廢：metadata（OCR 文字）仍有價值
      }
    }

    record.frames = keptMetas
      .map(({ srcFile: _src, ...meta }) => meta)
      .sort((a, b) => a.ts - b.ts);
    record.frames_kept = record.frames.length;
    record.status = 'ok';
    record.error = null;
    return record;
  } catch (err) {
    record.error = `exception: ${(err as Error).message}`;
    return record;
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
