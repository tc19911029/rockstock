/**
 * curlFetch — Node fetch + curl shell fallback
 *
 * 背景（2026-05-11）：TPEx openapi (tpex_mainboard_quotes) 對 Node 端的 TLS fingerprint
 * 越來越常被 Cloudflare 阻擋（403），但同一台機器的 curl 帶 Mozilla UA 即可 200。
 * 結果是 stocklist provider、L2 IntradayCache、download-candles 三條鏈在 cron 跑時
 * 同時失敗 → 全市場掃描整批漏抓上櫃股。
 *
 * 這個 helper：
 *   1. 先試 Node fetch（快、不需要 spawn 子程序）
 *   2. fetch 失敗或回 ≥400 → 用 curl shell（execFile + promisify）重試
 *
 * 使用情境：對外部第三方 API 抓 JSON（TWSE / TPEx openapi 等），尤其是 Cloudflare 護盾下的 endpoint。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { runWithCurlConcurrencyLimit } from './curlConcurrency';

const execFileAsync = promisify(execFile);

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── 本機代理 fallback（2026-06-12）────────────────────────────────────────────
// 本機直連對部分站（CMoney / MoneyDJ / TPEx / TWSE bulk）會被網路層 TLS reset
//（curl exit 35 / Node fetch ECONNRESET，中國線路時段性干擾），但本機 Clash/Verge
// 代理可通。互動 shell 有 HTTP(S)_PROXY env 所以手動 curl 一直「看起來正常」，
// launchd/server 進程沒有 proxy env → 06-11 settle bulk size=0、ETF 整晚
// no source available 的共同總根因。
// 策略：curl 直連失敗 → 依序帶 -x 試本機代理（7897 Verge / 7890 ClashX）；
// 成功的代理 cache 10 分鐘優先重用。代理都沒開時行為與原版完全相同（直連錯誤照拋）。
const LOCAL_PROXY_CANDIDATES = ['http://127.0.0.1:7897', 'http://127.0.0.1:7890'];
let workingProxyCache: { proxy: string; at: number } | null = null;
const PROXY_CACHE_TTL_MS = 10 * 60_000;

async function execCurlWithProxyFallback(
  baseArgs: string[],
  maxBuffer: number,
  proxyFirst = false,
): Promise<{ stdout: string }> {
  // -f：HTTP ≥400 讓 curl exit 22 而不是 0 — 否則 Cloudflare 403 challenge HTML 會被
  // 當成「成功」直接進 JSON.parse 炸掉，代理重試永遠不會觸發（2026-06-12 實測 TPEx openapi）
  baseArgs = ['-f', ...baseArgs];
  const run = (args: string[]) => runWithCurlConcurrencyLimit(
    () => execFileAsync('curl', args, { encoding: 'utf-8', maxBuffer }),
  );
  const cached = workingProxyCache && Date.now() - workingProxyCache.at < PROXY_CACHE_TTL_MS
    ? workingProxyCache.proxy : null;
  const proxies = cached
    ? [cached, ...LOCAL_PROXY_CANDIDATES.filter((p) => p !== cached)]
    : [...LOCAL_PROXY_CANDIDATES];

  // proxyFirst（台灣站 TWSE/TPEx/Yahoo 用）：中國線路直連這些站會 hang（fake-ip），代理 ~1s 就通 →
  // 代理優先、全失敗才直連兜底（人不在中國/代理沒開時直連會通）。
  if (proxyFirst) {
    let lastErr: unknown = null;
    for (const proxy of proxies) {
      try { const r = await run(['-x', proxy, ...baseArgs]); workingProxyCache = { proxy, at: Date.now() }; return r; }
      catch (e) { lastErr = e; }
    }
    try { return await run([...baseArgs, '--max-time', '5']); }
    catch (e) { throw e instanceof Error ? e : (lastErr ?? e); }
  }

  // 預設：直連優先（5s 上限，curl 取最後一個 --max-time）→ 代理。
  try {
    return await run([...baseArgs, '--max-time', '5']);
  } catch (directErr) {
    let lastErr: unknown = directErr;
    for (const proxy of proxies) {
      try { const r = await run(['-x', proxy, ...baseArgs]); workingProxyCache = { proxy, at: Date.now() }; return r; }
      catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
}

interface CurlFetchOptions {
  /** 總 timeout（ms），同時用於 Node fetch 與 curl --max-time */
  timeoutMs?: number;
  /** 自訂 headers（會傳給 fetch 與 curl 兩端） */
  headers?: Record<string, string>;
  /** 自訂 User-Agent（會被 headers['User-Agent'] 蓋過） */
  userAgent?: string;
  /** curl 子程序的 stdout 上限（bytes），預設 50MB */
  maxBuffer?: number;
  /** HTTP method（預設 GET；2026-06-12 B2 加 — TPEx /www/zh-tw/margin/sbl 是 POST）*/
  method?: 'GET' | 'POST';
  /** POST body（x-www-form-urlencoded 字串；fetch 與 curl 兩端共用）*/
  body?: string;
  /** 代理優先（台灣站 TWSE/TPEx/Yahoo 用）：跳過 Node fetch 直連、curl 也代理優先。
   *  中國線路對這些站直連 fake-ip hang、代理 ~1s 通；代理沒開/不在中國時自動退直連，故各環境皆安全。 */
  proxyFirst?: boolean;
}

export type CurlFetchSource = 'node-fetch' | 'curl';

export interface CurlFetchResult<T> {
  data: T;
  source: CurlFetchSource;
}

/**
 * 抓 JSON，Node fetch 失敗就走 curl。回傳 parsed JSON + 哪條 source 來的（log 用）。
 *
 * 失敗條件：
 *   - Node fetch throw（網路錯、timeout、AbortError）
 *   - HTTP status >= 400（403 是常見 Cloudflare block）
 *   - JSON parse 失敗
 *
 * 若兩條都失敗，throw 最後一個錯誤。
 */
export async function fetchJsonWithCurlFallback<T>(
  url: string,
  options: CurlFetchOptions = {},
): Promise<CurlFetchResult<T>> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const ua = options.headers?.['User-Agent'] ?? options.userAgent ?? DEFAULT_UA;
  const headers: Record<string, string> = { 'User-Agent': ua, ...(options.headers ?? {}) };
  const maxBuffer = options.maxBuffer ?? 50 * 1024 * 1024;

  // ── TPEx 特例（2026-06-12，QA 提案 #4）：Cloudflare 對 Node fetch 的 TLS 指紋
  // 幾乎必擋（06-11 settle bulk size=0 的元兇之一），curl 帶瀏覽器 header 可過。
  // 對 tpex.org.tw 直接 curl-first（省一次必死的 fetch round-trip）+ 自動補 Referer。
  const isTpex = url.includes('tpex.org.tw');
  if (isTpex && !headers['Referer']) {
    headers['Referer'] = 'https://www.tpex.org.tw/zh-tw/mainboard/trading/info/stock-pricing.html';
  }

  // ── 1) Node fetch 第一試（TPEx / proxyFirst 跳過） ───────────────────
  const proxyFirst = options.proxyFirst ?? false;
  let lastErr: unknown = null;
  if (!isTpex && !proxyFirst) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)), // 直連 5s 上限：台站在中國線路 hang，快退 curl→代理
        headers,
        ...(options.method === 'POST' ? { method: 'POST', body: options.body ?? '' } : {}),
      });
      if (res.ok) {
        const data = await res.json() as T;
        return { data, source: 'node-fetch' };
      }
      lastErr = new Error(`HTTP ${res.status}`);
      // 403/429/5xx → 落到 curl
    } catch (err) {
      lastErr = err;
    }
  } else {
    lastErr = new Error(proxyFirst ? 'proxyFirst → curl 代理優先' : 'tpex.org.tw → curl-first（跳過 node fetch）');
  }

  // ── 2) curl shell fallback ────────────────────────────────────────
  try {
    // -4 強制 IPv4：dev server child process 環境 IPv6 路由可能撞不同 Cloudflare edge
    // 被當 bot 擋（0514 實測：tpex_mainboard_quotes 從 shell curl 200，從 Node spawn curl
    // 回 HTML challenge page）。手動 shell 用 -i 觀察 cf-ray 看 edge 差異可確認。
    const args = ['-s', '-4', '--max-time', String(Math.ceil(timeoutMs / 1000))];
    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${v}`);
    }
    if (options.method === 'POST') {
      args.push('-X', 'POST', '--data', options.body ?? '');
    }
    args.push(url);
    const { stdout } = await execCurlWithProxyFallback(args, maxBuffer, proxyFirst);
    if (!stdout || stdout.length === 0) {
      throw new Error('curl returned empty stdout');
    }
    const data = JSON.parse(stdout) as T;
    return { data, source: 'curl' };
  } catch (err) {
    // 兩條都掛 → throw 最後錯誤（包含 fetch 與 curl 兩條都的 trace）
    const fetchMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const curlMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`fetch failed (${fetchMsg}); curl fallback also failed (${curlMsg})`);
  }
}

/**
 * 抓 UTF-8 文字（HTML / 純文字），Node fetch 失敗 *或內容沒過 validate* 就走 curl。
 *
 * 背景（2026-06-15）：Yahoo 籌碼分頁（tw.stock.yahoo.com/.../broker-trading）對 Node 端
 * fetch 回 **200 OK 但只有 ~3KB 的反爬蟲 stub**（真頁是 ~340KB、含 `"brokerTrades":` JSON），
 * 同一台機器的 curl 帶 Mozilla UA 卻拿得到完整頁。因為是 200 不是 4xx，純看 status 的
 * fallback 不會觸發 → 主力分點 snapshot 每天 missed:250、籌碼集中度卡在舊日期。
 *
 * 所以這個 helper 多收一個 `validate(text)`：Node fetch 即使 200，內容沒過驗證
 *（如「不含 brokerTrades marker」）也視為失敗、改走 curl（含本機代理 fallback）。
 */
export async function fetchTextWithCurlFallback(
  url: string,
  options: CurlFetchOptions & { validate?: (text: string) => boolean } = {},
): Promise<{ text: string; source: CurlFetchSource }> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const ua = options.headers?.['User-Agent'] ?? options.userAgent ?? DEFAULT_UA;
  const headers: Record<string, string> = { 'User-Agent': ua, ...(options.headers ?? {}) };
  const maxBuffer = options.maxBuffer ?? 50 * 1024 * 1024;
  const validate = options.validate ?? (() => true);

  // ── 1) Node fetch 第一試（內容要過 validate；proxyFirst 跳過） ─────────
  const proxyFirst = options.proxyFirst ?? false;
  let lastErr: unknown = null;
  if (!proxyFirst) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)), headers });
      if (res.ok) {
        const text = await res.text();
        if (validate(text)) return { text, source: 'node-fetch' };
        lastErr = new Error(`node fetch 200 but content failed validation (anti-bot stub? ${text.length}B)`);
      } else {
        lastErr = new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      lastErr = err;
    }
  } else {
    lastErr = new Error('proxyFirst → curl 代理優先');
  }

  // ── 2) curl shell fallback（含本機代理 fallback） ─────────────────────
  try {
    const args = ['-s', '-4', '--max-time', String(Math.ceil(timeoutMs / 1000))];
    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${v}`);
    }
    args.push(url);
    const { stdout } = await execCurlWithProxyFallback(args, maxBuffer, proxyFirst);
    if (!stdout || stdout.length === 0) throw new Error('curl returned empty stdout');
    if (!validate(stdout)) throw new Error(`curl content failed validation (${stdout.length}B)`);
    return { text: stdout, source: 'curl' };
  } catch (err) {
    const fetchMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const curlMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`text fetch failed (${fetchMsg}); curl fallback also failed (${curlMsg})`);
  }
}

/**
 * 抓 binary（任意 encoding 的 raw bytes），Node fetch 失敗就走 curl。
 * 用途：Big5 / GBK 編碼的 HTML（ISIN C_public.jsp）— Node fetch 在 dev runtime
 * 經常被 Cloudflare 阻成 timeout，但 curl 1-2s 內就能回。
 */
export async function fetchBufferWithCurlFallback(
  url: string,
  options: CurlFetchOptions = {},
): Promise<{ buffer: Uint8Array; source: CurlFetchSource }> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const ua = options.headers?.['User-Agent'] ?? options.userAgent ?? DEFAULT_UA;
  const headers: Record<string, string> = { 'User-Agent': ua, ...(options.headers ?? {}) };
  const maxBuffer = options.maxBuffer ?? 50 * 1024 * 1024;

  let lastErr: unknown = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)), headers });
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      return { buffer: buf, source: 'node-fetch' };
    }
    lastErr = new Error(`HTTP ${res.status}`);
  } catch (err) {
    lastErr = err;
  }

  // curl binary 走 --output 寫暫存檔再讀（直接 stdout 接 binary 在某些 Node 版會炸）
  const tmpPath = `/tmp/curl-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
  try {
    const args = ['-s', '-4', '--max-time', String(Math.ceil(timeoutMs / 1000))];
    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${v}`);
    }
    args.push('--output', tmpPath, url);
    await execCurlWithProxyFallback(args, maxBuffer);
    const fs = await import('node:fs');
    const buf = new Uint8Array(fs.readFileSync(tmpPath));
    fs.unlinkSync(tmpPath);
    if (buf.length === 0) throw new Error('curl wrote empty file');
    return { buffer: buf, source: 'curl' };
  } catch (err) {
    try { (await import('node:fs')).unlinkSync(tmpPath); } catch { /* file may not exist */ }
    const fetchMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const curlMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`fetch buffer failed (${fetchMsg}); curl fallback also failed (${curlMsg})`);
  }
}
