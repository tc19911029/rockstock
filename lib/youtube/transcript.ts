/**
 * Transcript fetching (yt-dlp --write-subs) + VTT parser。
 *
 * MVP 3 起手範圍（決議 A）：只抓「人工字幕」的來源（實測僅 ustvmoney100）。
 * 其他 5 家 sources 沒任何字幕（含自動字幕），會回 status='unavailable'。
 * 留 extension hook：未來可加 Whisper 本地音訊轉文字 / yt-dlp description fallback。
 *
 * 設計：
 *   - yt-dlp 寫 VTT 到 tmp dir，parse 完即刪
 *   - 抓字幕 yt-dlp 啟動 ~2s + 下載 ~1s ≈ 3s/支
 *   - 對 60-100 支/日預估 < 300s，cron 內可序列跑完
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ytdlpProxyArgs } from './ytdlp';

const DEFAULT_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const DEFAULT_TIMEOUT_MS = 30_000;
const PREFERRED_LANGS = ['zh-Hant', 'zh-TW', 'zh', 'zh-Hans', 'en'];

export interface TranscriptCue {
  start: number;        // seconds
  end: number;
  text: string;
}

export interface TranscriptFetchResult {
  available: boolean;       // 是否抓到任何字幕檔
  manual: boolean;          // 是否為人工字幕（非自動）
  lang: string | null;      // 實際抓到的語言
  text: string;             // 所有 cue text join
  cues: TranscriptCue[];    // 解析後的 cue 陣列
  char_count: number;
  vtt_bytes: number;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

type Runner = (cmd: string, args: string[], opts?: object) => ChildProcess;

export interface FetchTranscriptOptions {
  /** 影片 watch URL（必須是 youtube.com/watch?v=ID 形式） */
  videoUrl: string;
  /** 偏好語言（依序嘗試）。預設 PREFERRED_LANGS */
  preferredLangs?: string[];
  /** 只抓人工字幕？預設 true（A 路線：不接受自動字幕的錯亂版） */
  manualOnly?: boolean;
  /** spawn 注入點（test 用） */
  runner?: Runner;
  timeoutMs?: number;
  bin?: string;
}

/**
 * 抓單一影片字幕，回傳解析後結果 + 是否可用。
 * 不 throw — 失敗訊息走 stderr/exit_code，caller 寫進 transcript record。
 */
export async function fetchTranscript(opts: FetchTranscriptOptions): Promise<TranscriptFetchResult> {
  const langs = opts.preferredLangs ?? PREFERRED_LANGS;
  const manualOnly = opts.manualOnly ?? true;
  const runner = opts.runner ?? spawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bin = opts.bin ?? DEFAULT_BIN;

  const work = await fs.mkdtemp(path.join(tmpdir(), 'yt-subs-'));
  try {
    const args = [
      '--skip-download',
      '--write-subs',
      ...(manualOnly ? [] : ['--write-auto-subs']),
      '--sub-langs', langs.join(','),
      '--convert-subs', 'vtt',
      '--no-warnings',
      '--ignore-config',
      ...ytdlpProxyArgs(),
      '-o', path.join(work, '%(id)s.%(ext)s'),
      opts.videoUrl,
    ];

    const extraPaths = [`${homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin'];
    const augmentedPath = [...extraPaths, process.env.PATH || ''].filter(Boolean).join(':');

    const child = runner === spawn
      ? (spawn(bin, args, { env: { ...process.env, PATH: augmentedPath } }) as ChildProcess)
      : runner(bin, args);

    const { stderr, exitCode, timedOut } = await new Promise<{
      stderr: string; exitCode: number | null; timedOut: boolean;
    }>((resolve) => {
      let stderrBuf = '';
      let timed = false;
      const timer = setTimeout(() => {
        timed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000);
      }, timeoutMs);
      child.stderr?.setEncoding?.('utf-8');
      child.stderr?.on('data', (chunk: string) => {
        stderrBuf += chunk;
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
      });
      child.stdout?.on('data', () => { /* drain */ });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ stderr: stderrBuf + `\nspawn error: ${err.message}`, exitCode: null, timedOut: timed });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ stderr: stderrBuf, exitCode: code, timedOut: timed });
      });
    });

    // 找出寫出的 VTT（檔名 pattern: {video_id}.{lang}.vtt）
    const files = await fs.readdir(work);
    const vttFiles = files.filter(f => f.endsWith('.vtt'));

    if (vttFiles.length === 0) {
      return {
        available: false, manual: false, lang: null, text: '', cues: [],
        char_count: 0, vtt_bytes: 0, stderr, exit_code: exitCode, timed_out: timedOut,
      };
    }

    // 依偏好語言序選最優先的
    const pickFile = (() => {
      for (const lang of langs) {
        const hit = vttFiles.find(f => f.includes(`.${lang}.`));
        if (hit) return { name: hit, lang };
      }
      // 沒匹配偏好 → 用第一個
      const fb = vttFiles[0];
      const m = fb.match(/\.([\w-]+)\.vtt$/);
      return { name: fb, lang: m ? m[1] : 'unknown' };
    })();

    const vttPath = path.join(work, pickFile.name);
    const vttRaw = await fs.readFile(vttPath, 'utf-8');
    const parsed = parseVtt(vttRaw);

    return {
      available: true,
      manual: manualOnly,             // 若 manualOnly=true 抓到就一定是人工
      lang: pickFile.lang,
      text: parsed.text,
      cues: parsed.cues,
      char_count: parsed.text.length,
      vtt_bytes: Buffer.byteLength(vttRaw, 'utf-8'),
      stderr, exit_code: exitCode, timed_out: timedOut,
    };
  } finally {
    // 清掉 tmp dir
    await fs.rm(work, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }
}

/**
 * VTT parser — 簡化版，只取 cue 區塊。
 *
 * VTT 結構：
 *   WEBVTT
 *   Kind: captions          (optional)
 *   Language: zh-Hant       (optional)
 *
 *   00:00:00.366 --> 00:00:00.933
 *   插播一下
 *
 *   00:00:00.933 --> 00:00:02.000
 *   我們進棚到現在
 *
 * 注意：
 *   - YouTube 自動字幕會有 <c> tag inline timing — 全部 strip
 *   - 同一 cue 可能多行 text — join with space
 *   - timestamp 容錯：HH 可省略（只有 MM:SS.mmm）
 */
export interface VttParseResult {
  text: string;             // 全部 cue text join with newline
  cues: TranscriptCue[];
}

const CUE_TS_RE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})\.(\d{1,3})\s+-->\s+(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})\.(\d{1,3})/;

export function parseVtt(raw: string): VttParseResult {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const cues: TranscriptCue[] = [];
  let i = 0;
  // skip header
  while (i < lines.length && !CUE_TS_RE.test(lines[i].trim())) i++;

  while (i < lines.length) {
    const tsLine = lines[i].trim();
    const m = tsLine.match(CUE_TS_RE);
    if (!m) { i++; continue; }
    const start = tsToSec(m[1], m[2], m[3], m[4]);
    const end = tsToSec(m[5], m[6], m[7], m[8]);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !CUE_TS_RE.test(lines[i].trim())) {
      textLines.push(stripVttInline(lines[i]));
      i++;
    }
    const text = textLines.join(' ').trim();
    if (text) {
      cues.push({ start, end, text });
    }
    // skip blank line
    while (i < lines.length && lines[i].trim() === '') i++;
  }

  // dedupe 連續完全相同的 cue text（YouTube 自動字幕常見：「我是來」「我是來」「我是來自台北」滾動）
  const dedupedCues = dedupeRollingCues(cues);
  const text = dedupedCues.map(c => c.text).join('\n');
  return { text, cues: dedupedCues };
}

function tsToSec(h: string | undefined, m: string, s: string, ms: string): number {
  return (h ? Number(h) * 3600 : 0) + Number(m) * 60 + Number(s) + Number(ms) / Math.pow(10, ms.length);
}

function stripVttInline(line: string): string {
  // 移除 <c> <00:00:00.000> <v Name> 等 inline tag
  return line
    .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
    .replace(/<\/?c[^>]*>/g, '')
    .replace(/<\/?v[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * YouTube 自動字幕 rolling 滾動式重複 dedup。
 * 例：cue[i]="ABC"  cue[i+1]="ABC DEF"  cue[i+2]="ABC DEF GHI"
 *     → 保留最長那個。手動字幕沒這現象，跑進來無 side effect。
 */
function dedupeRollingCues(cues: TranscriptCue[]): TranscriptCue[] {
  const out: TranscriptCue[] = [];
  for (const c of cues) {
    const last = out[out.length - 1];
    if (last && c.text.startsWith(last.text)) {
      out[out.length - 1] = c;
    } else {
      out.push(c);
    }
  }
  return out;
}

/** test 用：產生隨機 tmp 子路徑 fixture */
export function _tmpSubpath(prefix = 'test'): string {
  return path.join(tmpdir(), `${prefix}-${randomBytes(4).toString('hex')}`);
}
