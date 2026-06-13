/**
 * Whisper fallback for no-subtitle sources。
 *
 * 流程：
 *   1. yt-dlp 抓 audio (m4a) 到 tmp dir
 *   2. spawn python3 scripts/whisper-transcribe.py → 產 VTT 到 stdout
 *   3. 把 VTT 寫進 tmp 檔，回傳 path 讓 transcript.ts 的 parseVtt 處理
 *
 * 設計：
 *   - 不依賴外部 python pacakge 路徑，純 spawn `python3` (系統內建)
 *   - faster-whisper 需 pre-install: `python3 -m pip install --user faster-whisper`
 *   - 模型首次跑會自動下載到 ~/.cache/huggingface (~1.5 GB for medium)
 *   - 速度：M-series + medium 約 4x realtime → 25min 影片 ~6min 處理
 *
 * Concurrency：全程序 mutex，同時只准 1 個 Whisper instance 跑。
 *   - 多 in-flight HTTP request 排隊等
 *   - 避免並行多 Whisper 把 dev server OOM kill
 *   - 2026-05-22 dev server 重啟 bug 的根因：多並行 Whisper × 1.5GB model × N → 系統 OOM
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ytdlpProxyArgs } from './ytdlp';
import { beginTranscription, endTranscription } from './transcriptionLock';

const DEFAULT_YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const DEFAULT_PYTHON = process.env.PYTHON_BIN || 'python3';
// 改 'small' (default): M-series 約 4-5x realtime，比 medium 快 ~2.5 倍。
// 中文準確率 85-88% (vs medium 90-93%)。對股票分析夠用，且不會卡 48min 全集。
// 要更高品質改 env: WHISPER_MODEL=medium (或 large-v3)
const DEFAULT_WHISPER_MODEL = process.env.WHISPER_MODEL || 'small';
const DEFAULT_LANGUAGE = 'zh';

const PROJECT_ROOT = process.cwd();
const WHISPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'whisper-transcribe.py');

export interface WhisperResult {
  ok: boolean;
  vttPath: string | null;        // 寫好的 VTT 檔路徑
  audioBytes: number;
  durationSec: number | null;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface WhisperOptions {
  videoUrl: string;
  /** 音訊下載超時 (default 180s) */
  downloadTimeoutMs?: number;
  /** Whisper 轉錄超時 (default 1800s = 30min for safety) */
  transcribeTimeoutMs?: number;
  model?: string;
  language?: string;
}

function augmentedPath(): string {
  const extras = [`${homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin'];
  return [...extras, process.env.PATH || ''].filter(Boolean).join(':');
}

async function spawnAwait(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string; stdoutToFile?: string },
): Promise<{ exitCode: number | null; stderr: string; stdout: string; timedOut: boolean }> {
  return new Promise(async (resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    let outStream: NodeJS.WritableStream | null = null;
    if (opts.stdoutToFile) {
      // 寫到檔案而非 buffer，避免大檔記憶體爆掉
      const handle = await fs.open(opts.stdoutToFile, 'w');
      outStream = handle.createWriteStream();
    }

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, PATH: augmentedPath() },
      });
    } catch (err) {
      resolve({ exitCode: null, stderr: `spawn failed: ${(err as Error).message}`, stdout: '', timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3_000);
    }, opts.timeoutMs);

    if (outStream) {
      child.stdout?.pipe(outStream);
    } else {
      child.stdout?.setEncoding?.('utf-8');
      child.stdout?.on('data', (c: string) => {
        stdoutBuf += c;
        if (stdoutBuf.length > 1 * 1024 * 1024) stdoutBuf = stdoutBuf.slice(-1024 * 1024);
      });
    }
    child.stderr?.setEncoding?.('utf-8');
    child.stderr?.on('data', (c: string) => {
      stderrBuf += c;
      if (stderrBuf.length > 32 * 1024) stderrBuf = stderrBuf.slice(-32 * 1024);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (outStream) (outStream as NodeJS.WritableStream).end();
      resolve({ exitCode: null, stderr: stderrBuf + `\nerror: ${err.message}`, stdout: stdoutBuf, timedOut });
    });
    child.on('exit', async (code) => {
      clearTimeout(timer);
      if (outStream) {
        await new Promise<void>((res) => (outStream as NodeJS.WritableStream).end(() => res()));
      }
      resolve({ exitCode: code, stderr: stderrBuf, stdout: stdoutBuf, timedOut });
    });
  });
}

// ── Mutex: 全程序內最多 1 個 Whisper instance ─────────────────────
// 防 OOM：每個 Whisper 載 1.5 GB model + 500 MB audio buffer，N 並行直接爆系統記憶體
let whisperLock: Promise<void> = Promise.resolve();
async function acquireWhisperLock(): Promise<() => void> {
  const prev = whisperLock;
  let release!: () => void;
  whisperLock = new Promise<void>((resolve) => { release = resolve; });
  await prev;
  return release;
}

/**
 * 對 video URL 跑「下載音訊 → Whisper 轉錄」，產出 VTT 檔到 work dir。
 * 不負責 parse VTT — 把 path 回給 caller，由 transcript.ts 的 parseVtt 處理。
 *
 * 受全程序 mutex 保護：同時只跑 1 個。多 caller 自動排隊。
 */
export async function transcribeViaWhisper(opts: WhisperOptions): Promise<WhisperResult> {
  const release = await acquireWhisperLock();
  // 轉錄期間標記 active → instrumentation.ts 的記憶體重活 cron 讓路，避免 jetsam 砍 Whisper
  // 子程序（見 transcriptionLock.ts root-cause）。標在 mutex 內，整段下載+轉錄都算 active。
  beginTranscription();
  try {
    return await transcribeViaWhisperUnsafe(opts);
  } finally {
    endTranscription();
    release();
  }
}

async function transcribeViaWhisperUnsafe(opts: WhisperOptions): Promise<WhisperResult> {
  const work = await fs.mkdtemp(path.join(tmpdir(), 'yt-whisper-'));
  const audioId = randomBytes(4).toString('hex');
  const audioPath = path.join(work, `${audioId}.m4a`);
  const vttPath = path.join(work, `${audioId}.vtt`);

  try {
    // 1) yt-dlp 抓 audio
    const downloadArgs = [
      '-x', '--audio-format', 'm4a',
      '--audio-quality', '5',         // 0-10, 5 是中間值，足夠 ASR
      '--no-warnings', '--ignore-config',
      ...(await ytdlpProxyArgs()),
      '-o', audioPath,
      opts.videoUrl,
    ];
    const download = await spawnAwait(DEFAULT_YTDLP_BIN, downloadArgs, {
      timeoutMs: opts.downloadTimeoutMs ?? 180_000,
    });

    let audioBytes = 0;
    try { audioBytes = (await fs.stat(audioPath)).size; } catch { /* missing */ }

    if (download.exitCode !== 0 || audioBytes === 0) {
      return {
        ok: false, vttPath: null, audioBytes,
        durationSec: null,
        stderr: `yt-dlp audio download failed: ${download.stderr.slice(-500)}`,
        exitCode: download.exitCode, timedOut: download.timedOut,
      };
    }

    // 2) Whisper 轉錄 → 寫 VTT
    const whisperArgs = [
      WHISPER_SCRIPT, audioPath,
      opts.model ?? DEFAULT_WHISPER_MODEL,
      opts.language ?? DEFAULT_LANGUAGE,
    ];
    const transcribe = await spawnAwait(DEFAULT_PYTHON, whisperArgs, {
      timeoutMs: opts.transcribeTimeoutMs ?? 1_800_000,
      stdoutToFile: vttPath,
    });

    // 從 stderr 撈 duration（whisper script 自己 print）
    const durMatch = transcribe.stderr.match(/duration=([\d.]+)s/);
    const durationSec = durMatch ? Number(durMatch[1]) : null;

    let vttBytes = 0;
    try { vttBytes = (await fs.stat(vttPath)).size; } catch { /* missing */ }

    if (transcribe.exitCode !== 0 || vttBytes === 0) {
      return {
        ok: false, vttPath: null, audioBytes,
        durationSec,
        stderr: `whisper transcribe failed: ${transcribe.stderr.slice(-800)}`,
        exitCode: transcribe.exitCode, timedOut: transcribe.timedOut,
      };
    }

    return {
      ok: true,
      vttPath,
      audioBytes,
      durationSec,
      stderr: transcribe.stderr,
      exitCode: 0,
      timedOut: false,
    };
  } catch (err) {
    return {
      ok: false, vttPath: null, audioBytes: 0,
      durationSec: null,
      stderr: `exception: ${(err as Error).message}`,
      exitCode: null, timedOut: false,
    };
  }
  // 注意：刻意不清掉 work dir，caller 讀完 vtt 後負責清。或註冊 cleanup callback。
}

/** 讀 VTT 內容，並清掉整個 work dir。 */
export async function readVttAndCleanup(vttPath: string): Promise<string> {
  try {
    const content = await fs.readFile(vttPath, 'utf-8');
    return content;
  } finally {
    const workDir = path.dirname(vttPath);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }
}
