import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseVtt } from '@/lib/youtube/transcript';
import { gradeTranscript } from '@/lib/youtube/transcriptQuality';
import { beginTranscription, endTranscription } from '@/lib/youtube/transcriptionLock';
import type { CnMediaTranscript, CnMediaVideo } from './types';

const FFMPEG_BIN = process.env.FFMPEG_BIN || path.join(homedir(), '.local', 'bin', 'ffmpeg');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const WHISPER_MODEL = process.env.CN_MEDIA_WHISPER_MODEL || process.env.WHISPER_MODEL || 'small';
const WHISPER_SCRIPT = path.join(process.cwd(), 'scripts', 'whisper-transcribe.py');
const BILIBILI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36';

interface ProcessResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  stdoutPath?: string,
): Promise<ProcessResult> {
  let handle: FileHandle | null = null;
  try {
    handle = stdoutPath ? await fs.open(stdoutPath, 'w') : null;
    return await new Promise<ProcessResult>((resolve) => {
      const child = spawn(command, args, {
        env: {
          ...process.env,
          PATH: `${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
        },
        stdio: ['ignore', handle ? handle.fd : 'ignore', 'pipe'],
      });
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3_000);
      }, timeoutMs);
      child.stderr?.setEncoding('utf-8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
      });
      child.once('error', error => {
        clearTimeout(timer);
        resolve({ code: null, stderr: `${stderr}\n${error.message}`, timedOut });
      });
      child.once('exit', code => {
        clearTimeout(timer);
        resolve({ code, stderr, timedOut });
      });
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function transcribeCnMediaVideo(video: CnMediaVideo): Promise<CnMediaTranscript> {
  const fetchedAt = new Date().toISOString();
  if (!video.media_url) {
    return failed(video, fetchedAt, 'missing media_url');
  }

  const work = await fs.mkdtemp(path.join(tmpdir(), 'rockstock-cn-media-'));
  const token = randomBytes(4).toString('hex');
  const audioPath = path.join(work, `${token}.m4a`);
  const vttPath = path.join(work, `${token}.vtt`);
  beginTranscription();
  try {
    const inputHeaders = video.platform === 'bilibili'
      ? ['-user_agent', BILIBILI_USER_AGENT, '-headers', 'Referer: https://www.bilibili.com/\r\n']
      : [];
    const download = await runProcess(FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...inputHeaders,
      '-i', video.media_url,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k',
      audioPath,
    ], 20 * 60_000);
    const audioSize = await fs.stat(audioPath).then(stat => stat.size).catch(() => 0);
    if (download.code !== 0 || audioSize === 0) {
      return failed(video, fetchedAt, `ffmpeg failed: ${download.stderr.slice(-600)}`);
    }

    const whisper = await runProcess(PYTHON_BIN, [
      WHISPER_SCRIPT, audioPath, WHISPER_MODEL, 'zh',
    ], 45 * 60_000, vttPath);
    const vtt = await fs.readFile(vttPath, 'utf-8').catch(() => '');
    if (whisper.code !== 0 || !vtt) {
      return failed(video, fetchedAt, `whisper failed: ${whisper.stderr.slice(-800)}`);
    }

    const parsed = parseVtt(vtt);
    const fetched = {
      available: parsed.text.length > 0,
      manual: false,
      lang: 'zh-CN',
      text: parsed.text,
      cues: parsed.cues,
      char_count: parsed.text.length,
      vtt_bytes: Buffer.byteLength(vtt),
      stderr: whisper.stderr,
      exit_code: whisper.code,
      timed_out: whisper.timedOut,
    };
    const grade = gradeTranscript({ fetched, title: video.title });
    return {
      video_id: video.video_id,
      source_id: video.source_id,
      date: video.program_date,
      fetched_at: fetchedAt,
      status: grade.status === 'available' ? 'available' : 'low_quality',
      quality_score: grade.score,
      char_count: parsed.text.length,
      cue_count: parsed.cues.length,
      text: parsed.text,
      cues: parsed.cues,
      error: null,
    };
  } catch (error) {
    return failed(video, fetchedAt, (error as Error).message);
  } finally {
    endTranscription();
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

function failed(video: CnMediaVideo, fetchedAt: string, error: string): CnMediaTranscript {
  return {
    video_id: video.video_id,
    source_id: video.source_id,
    date: video.program_date,
    fetched_at: fetchedAt,
    status: 'failed',
    quality_score: 0,
    char_count: 0,
    cue_count: 0,
    text: '',
    cues: [],
    error,
  };
}
