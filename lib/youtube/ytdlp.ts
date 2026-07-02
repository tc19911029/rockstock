/**
 * yt-dlp subprocess wrapper。
 *
 * 為什麼用 spawn 而非 exec：
 *   --flat-playlist 輸出 NDJSON（每行一支影片）。流式逐行 parse 比一次性 collect 安全；
 *   單行壞掉不影響整批。
 *
 * 為什麼 runner 可注入：
 *   contract test 餵 NDJSON fixture 不用真的呼叫 yt-dlp binary，免網路依賴。
 *
 * 為什麼不用 retry：
 *   yt-dlp 對 429/網路錯誤已有內建退避；caller 端再 retry 容易爆 quota。
 *   非 0 exit 直接寫進 scan_log.error，下次 cron tick 自然重來。
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

export interface YtdlpVideo {
  id: string;
  title: string;
  url: string;
  duration?: number | null;
  upload_date?: string;       // YYYYMMDD
  timestamp?: number;          // unix seconds
  view_count?: number | null;
  live_status?: string | null; // is_live / was_live / not_live / post_live / is_upcoming
  channel_id?: string;
}

/** spawn 注入點 — runner(cmd, args) → { stdout, stderr, on('exit'), kill() } */
type Runner = (cmd: string, args: string[]) => ChildProcess;

const DEFAULT_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * yt-dlp proxy 決策 — 執行期探測，不再寫死。
 *
 * 歷史上兩種互斥的故障模式都發生過：
 *   A. 2026-06-08（ClashX 時代）：系統 proxy 指向已關掉的 127.0.0.1:7890 →
 *      yt-dlp 讀系統 proxy 卡死 → 當時解法是強制 `--proxy ''` 直連。
 *   B. 2026-06-09 / 06-11（Verge 時代）：Verge TUN 沒開時 yt-dlp「直連」反而
 *      整批 timeout（curl 直連通、Python 不通），但本機 proxy 127.0.0.1:7897 是活的
 *      → 06-11 全來源 90s timeout、整天節目漏抓的根因。
 * 寫死任何一邊都會在另一個模式翻車，所以改成探測：
 *   1. `YTDLP_PROXY` env 顯式覆寫 → 直接用（逃生口，含設成 '' 強制直連）。
 *   2. 用 curl 經本機代理（7897 Verge / 7890 ClashX）打 youtube generate_204，
 *      4s 內通 → 走該 proxy（本機代理活著時永遠安全）。
 *   3. 都不通 → `--proxy ''` 直連（= 模式 A 的原行為）。
 * 結果 cache 10 分鐘，避免每支影片都探測一次。
 */
let proxyProbeCache: { args: string[]; at: number } | null = null;
const PROXY_PROBE_TTL_MS = 10 * 60_000;
const LOCAL_PROXY_CANDIDATES = ['http://127.0.0.1:7897', 'http://127.0.0.1:7890'];

function probeProxy(proxy: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '4', '-x', proxy, 'https://www.youtube.com/generate_204'],
      { timeout: 6_000 },
      (err, stdout) => resolve(!err && /^(20[04])$/.test(String(stdout).trim())),
    );
  });
}

/**
 * 新版 yt-dlp（2026.06+）解 YouTube JS 挑戰需要 JS runtime，預設只認 deno；
 * 本機沒 deno 但有 node-22 → 明確指過去。沒有 node 就不帶 flag（降級模式，metadata 多半仍可用）。
 * 為什麼放這裡：所有 yt-dlp 呼叫點（scan/transcript/keyframes/whisper）都經過 ytdlpProxyArgs，
 * 而 spawn 帶 --ignore-config 吃不到 ~/.config/yt-dlp/config，只能在 args 注入。
 */
const NODE_BIN = `${homedir()}/.local/node-22/bin/node`;
function jsRuntimeArgs(): string[] {
  return existsSync(NODE_BIN) ? ['--js-runtimes', `node:${NODE_BIN}`] : [];
}

export async function ytdlpProxyArgs(): Promise<string[]> {
  if (process.env.YTDLP_PROXY !== undefined) return ['--proxy', process.env.YTDLP_PROXY, ...jsRuntimeArgs()];
  if (proxyProbeCache && Date.now() - proxyProbeCache.at < PROXY_PROBE_TTL_MS) return proxyProbeCache.args;
  let args = ['--proxy', ''];
  for (const p of LOCAL_PROXY_CANDIDATES) {
    if (await probeProxy(p)) { args = ['--proxy', p]; break; }
  }
  args = [...args, ...jsRuntimeArgs()];
  proxyProbeCache = { args, at: Date.now() };
  return args;
}

export interface FetchOptions {
  limit?: number;
  runner?: Runner;
  timeoutMs?: number;
  bin?: string;
}

export interface FetchResult {
  videos: YtdlpVideo[];
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * 呼叫 yt-dlp 抓某個 channel/playlist 最近 N 支影片。
 * 不 throw — 把錯誤訊息回傳給 caller 寫進 scan log。
 */
export async function fetchRecentVideos(
  sourceUrl: string,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const limit = opts.limit ?? 20;
  const runner = opts.runner ?? spawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bin = opts.bin ?? DEFAULT_BIN;

  // 移除 --flat-playlist：flat 模式為了快會 strip 掉 duration/live_status，
  // 導致 classifyVideoType 多半 fall through 到 'unknown'。實測 (2026-05-22)
  // 完整模式 ~1.1s/支，6 × 20 = ~135s 仍遠在 300s maxDuration 內，值得換準確度。
  //
  // --skip-download：新版 yt-dlp (2026.03.17+) 預設會做 format selection；如果沒可用 format
  // 會 ERROR。我們只要 metadata 不要實際下載，明確 --skip-download。
  // 移掉 player_client=web 強制設定：新版 yt-dlp 自動挑可用 client（android_vr/mediaconnect 等）；
  // 強制 web 在 2026.03.17 會走到沒可用 format 的死路。
  const args = [
    '--dump-json',
    '--skip-download',
    '--playlist-end', String(limit),
    '--no-warnings',
    '--ignore-config',
    ...(await ytdlpProxyArgs()),
    sourceUrl,
  ];

  // Dev server 由 launchd 啟動時 PATH 不含 ~/.local/bin（yt-dlp 通常裝在那）。
  // 在 spawn 時擴充 PATH 而不改變 dev-server plist 設定。
  const extraPaths = [`${homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin'];
  const currentPath = process.env.PATH || '';
  const augmentedPath = [...extraPaths, currentPath].filter(Boolean).join(':');

  return new Promise<FetchResult>((resolve) => {
    let child: ChildProcess;
    try {
      // runner=spawn 用標準 env；測試注入的 runner 不關心 env，所以用 type assertion 走 spawn 的 third arg
      child = runner === spawn
        ? (spawn(bin, args, { env: { ...process.env, PATH: augmentedPath } }) as ChildProcess)
        : runner(bin, args);
    } catch (err) {
      resolve({
        videos: [],
        stderr: `spawn failed: ${(err as Error).message}`,
        exitCode: null,
        timedOut: false,
      });
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    const videos: YtdlpVideo[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 2_000);
    }, timeoutMs);

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        const v = parseLine(line);
        if (v) videos.push(v);
      }
    });

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBuf += chunk;
      // 防 stderr 爆量：保留尾端 8KB 就夠 debug
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      // 沖掉 stdoutBuf 剩餘行
      const tail = stdoutBuf.trim();
      if (tail) {
        const v = parseLine(tail);
        if (v) videos.push(v);
      }
      resolve({
        videos,
        stderr: stderrBuf + `\nspawn error: ${err.message}`,
        exitCode: null,
        timedOut,
      });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      const tail = stdoutBuf.trim();
      if (tail) {
        const v = parseLine(tail);
        if (v) videos.push(v);
      }
      resolve({ videos, stderr: stderrBuf, exitCode: code, timedOut });
    });
  });
}

function parseLine(line: string): YtdlpVideo | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj.id !== 'string' || typeof obj.title !== 'string') return null;
    // 移除 --flat-playlist 後 obj.url 變成 googlevideo 串流網址（會過期，不能存）。
    // 統一用 webpage_url（永久 watch URL），缺則從 id 組裝。
    const url = typeof obj.webpage_url === 'string'
      ? obj.webpage_url
      : `https://www.youtube.com/watch?v=${obj.id}`;
    return {
      id: obj.id,
      title: obj.title,
      url,
      duration: typeof obj.duration === 'number' ? obj.duration : null,
      upload_date: typeof obj.upload_date === 'string' ? obj.upload_date : undefined,
      timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : undefined,
      view_count: typeof obj.view_count === 'number' ? obj.view_count : null,
      live_status: typeof obj.live_status === 'string' ? obj.live_status : null,
      channel_id: typeof obj.channel_id === 'string' ? obj.channel_id : undefined,
    };
  } catch {
    return null;
  }
}

/** yt-dlp upload_date 是 YYYYMMDD（無時區）。轉成 Asia/Taipei 當日 09:00 ISO 當近似值。 */
export function uploadDateToIso(uploadDate: string | undefined, timestamp: number | undefined): string | null {
  if (timestamp && Number.isFinite(timestamp)) {
    return new Date(timestamp * 1000).toISOString();
  }
  if (uploadDate && /^\d{8}$/.test(uploadDate)) {
    const y = uploadDate.slice(0, 4);
    const m = uploadDate.slice(4, 6);
    const d = uploadDate.slice(6, 8);
    // 用 UTC 中午當近似（避免時區邊界推來推去；後面比較 72h 容忍 12h 誤差）
    return `${y}-${m}-${d}T12:00:00.000Z`;
  }
  return null;
}
