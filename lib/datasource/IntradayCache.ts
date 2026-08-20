/**
 * IntradayCache — Layer 2 盤中即時快取層
 *
 * 將全市場即時報價存為單一 JSON 檔案（非逐檔），
 * 確保粗掃時只需 1 次 Blob read（< 100ms），
 * 解決 Vercel 手機掃描超時（原本 3800 次 Blob read → 570s）。
 *
 * 資料來源:
 *   TW: TWSE mis API + TPEx → getTWSERealtimeIntraday()
 *   CN: EastMoney push2 → getEastMoneyRealtime()
 *
 * 儲存格式:
 *   Blob: intraday/{market}/{date}.json
 *   Local: data/intraday-{market}-{date}.json
 *
 * 此層獨立於 Layer 1（歷史日K），不可互相覆蓋。
 */

import { globalCache } from './MemoryCache';
import { isTradingDay } from '@/lib/utils/tradingDay';

// ── Types ───────────────────────────────────────────────────────────────────

/** 每個數據源的調用結果，供 Health API 使用 */
export interface DataSourceStatus {
  source: string;           // 'EastMoney' | 'Tencent' | 'TWSE' | 'TPEx'
  success: boolean;
  quoteCount: number;
  errorMessage?: string;
  responseTimeMs: number;
  timestamp: string;        // ISO
}

/** L2 刷新結果摘要（附加到 snapshot 響應） */
export interface L2RefreshSummary {
  sources: DataSourceStatus[];
  consecutiveEmptyCount: number;
  isTradingDayFlag: boolean;
  alertLevel: 'none' | 'warning' | 'critical';
}

export interface IntradayQuote {
  /** 純代碼 e.g. "2330", "600519" */
  symbol: string;
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 昨收（可用於算漲跌幅） */
  prevClose: number;
  /** 漲跌幅 % */
  changePercent: number;
  /** TW：false 代表 MIS 沒有成交價，close 僅為委託簿推估，禁止寫入任何 K 棒。 */
  isActualTrade?: boolean;
}

export interface IntradaySnapshot {
  market: 'TW' | 'CN';
  date: string;            // YYYY-MM-DD
  updatedAt: string;       // ISO timestamp
  count: number;
  quotes: IntradayQuote[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const MEMORY_TTL = 60 * 1000; // memory cache 60 秒
const IS_VERCEL = !!process.env.VERCEL;

// ── 數據源健康狀態（記憶體短窗口 failover）──────────────────────────────
// 舊的 cn-source-health.json 持久化 circuit breaker 已淘汰；檔案保留不刪，未來做 debug 時還能看。

// 各資料源的短時間窗口 failover：若在窗口內失敗過，先跳過，省掉 timeout 時間
const SOURCE_SKIP_WINDOW_MS = 60 * 1000; // 60 秒
const _sourceSkipUntil: Record<string, number> = {};
function shouldSkipSource(source: string): number | false {
  const until = _sourceSkipUntil[source] ?? 0;
  if (Date.now() < until) return until;
  return false;
}
function markSourceFailed(source: string): void {
  _sourceSkipUntil[source] = Date.now() + SOURCE_SKIP_WINDOW_MS;
}
function markSourceSucceeded(source: string): void {
  delete _sourceSkipUntil[source];
}

// 期望資料筆數（用於判斷 L2 刷新是否成功）：3062 CN / 1956 TW * 0.98
const CN_EXPECTED_COUNT = 3062;
const TW_EXPECTED_COUNT = 1956;
const SUCCESS_RATIO = 0.98;
const CN_SUCCESS_MIN = Math.floor(CN_EXPECTED_COUNT * SUCCESS_RATIO); // 3000
const TW_SUCCESS_MIN = Math.floor(TW_EXPECTED_COUNT * SUCCESS_RATIO); // 1916


// ── 數據源狀態追蹤（模組級） ──────────────────────────────────────────────

/** 每個市場最近一次刷新的各數據源狀態 */
const _lastSourceStatus: Record<string, DataSourceStatus[]> = {};

/** 每個市場連續空快照計數（API 都返回 0） */
const _consecutiveEmptyCount: Record<string, number> = { TW: 0, CN: 0 };

/** 每個市場最近一次嘗試刷新的時間（不論成功或失敗） */
const _lastRefreshAttempt: Record<string, string> = {};

/** 每個市場最近一次「成功」刷新的時間（有真的拿到 ≥1 筆 quote 才算） */
const _lastRefreshSuccess: Record<string, string> = {};

/** 取得指定市場最近一次刷新的數據源狀態 */
export function getDataSourceStatus(market: 'TW' | 'CN'): DataSourceStatus[] {
  return _lastSourceStatus[market] ?? [];
}

/** 取得指定市場連續空快照次數 */
export function getConsecutiveEmptyCount(market: 'TW' | 'CN'): number {
  return _consecutiveEmptyCount[market] ?? 0;
}

/** 取得指定市場最近一次嘗試刷新的時間（區分「cron 沒跑」vs「API 掛了用快取」） */
export function getLastRefreshAttempt(market: 'TW' | 'CN'): string | null {
  return _lastRefreshAttempt[market] ?? null;
}

/** 取得指定市場最近一次「成功」刷新的時間 */
export function getLastRefreshSuccess(market: 'TW' | 'CN'): string | null {
  return _lastRefreshSuccess[market] ?? null;
}

/**
 * L2 polling watchdog：盤中時若上次成功刷新距今 > thresholdMin 分鐘 → 視為異常。
 *
 * 2026-05-21 加。背景：新 Mac 5/20 12:10 L2 polling 突然停（dev server 重啟），
 * 之後 80 分鐘沒人發現，收盤 append-from-snapshot 拿到 stale L2 → L1 5/20 ~180 檔錯。
 *
 * 回傳：
 *   { stale: true, lastSuccessAt, staleMin } — 盤中且 > 10 分鐘沒成功
 *   { stale: false, ... } — 一切正常或非盤中
 */
export function checkL2PollingHealth(
  market: 'TW' | 'CN',
  thresholdMin = 10,
): { stale: boolean; lastSuccessAt: string | null; staleMin: number; isMarketOpen: boolean } {
  // 動態 import 避免循環依賴
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isMarketOpen } = require('./marketHours') as typeof import('./marketHours');
  const open = isMarketOpen(market);
  const lastSuccess = _lastRefreshSuccess[market];
  if (!lastSuccess) {
    return { stale: open, lastSuccessAt: null, staleMin: Infinity, isMarketOpen: open };
  }
  const staleMs = Date.now() - new Date(lastSuccess).getTime();
  const staleMin = staleMs / 60_000;
  return {
    stale: open && staleMin > thresholdMin,
    lastSuccessAt: lastSuccess,
    staleMin: Math.round(staleMin * 10) / 10,
    isMarketOpen: open,
  };
}

const PROVIDER_TIMEOUT_MS = 12_000;
const REFRESH_HARD_TIMEOUT_MS = 45_000;
const CROSS_VALIDATE_TIMEOUT_MS = 6_000;

/**
 * 保證上游 Promise 一定會在期限內回到 caller。
 * 部分 vendor SDK 自己的 timeout 曾失效，若它被 single-flight 保留，後續所有 cron 都會永遠共用同一個 pending Promise。
 */
export function withIntradayTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 計時工具；每個 provider 都有獨立上限，避免 fallback chain 卡住。 */
function timedFetch<T>(fn: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const start = Date.now();
  return withIntradayTimeout(fn(), PROVIDER_TIMEOUT_MS, 'intraday provider')
    .then(result => ({ result, elapsedMs: Date.now() - start }));
}

// ── Blob / FS helpers ───────────────────────────────────────────────────────

function blobKey(market: 'TW' | 'CN', date: string): string {
  return `intraday/${market}/${date}.json`;
}

function localFilename(market: 'TW' | 'CN', date: string): string {
  return `intraday-${market}-${date}.json`;
}

async function blobPut(pathname: string, data: string): Promise<void> {
  const { put } = await import('@vercel/blob');
  await put(pathname, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
}

async function blobGet(pathname: string): Promise<string | null> {
  const { get } = await import('@vercel/blob');
  const result = await get(pathname, { access: 'private' });
  if (!result || !result.stream) return null;
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fsPut(filename: string, data: string): Promise<void> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  const dir = path.join(process.cwd(), 'data');
  await fs.mkdir(dir, { recursive: true });
  await atomicFsPut(path.join(dir, filename), data);
}

async function fsGet(filename: string): Promise<string | null> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  try {
    return await fs.readFile(path.join(process.cwd(), 'data', filename), 'utf-8');
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * 寫入全市場盤中快照（單一檔案）
 * 由 cron 或掃描前自動觸發
 */
export async function writeIntradaySnapshot(snapshot: IntradaySnapshot): Promise<void> {
  // 寫入前自檢：偵測 mis.twse 類「假裝沒漲跌」的 quote。出現代表上游 close
  // resolver 又踩坑（如新 vendor 或 API schema 異動），不擋寫入但 log 出來，
  // 讓 ops/audit 立刻看見。
  try {
    const { checkLimitUpConsistency } = await import('./limitUpConsistency');
    const check = checkLimitUpConsistency(snapshot.quotes as unknown as Parameters<typeof checkLimitUpConsistency>[0]);
    if (check.suspicious > 0) {
      console.error(
        `[IntradayCache] ★ ${snapshot.market} ${snapshot.date} 寫入發現 ${check.suspicious} 檔假裝沒漲跌的 quote: ` +
        check.samples.slice(0, 5).map(s => `${s.symbol}(${s.reason} O=${s.open} H=${s.high} L=${s.low} C=${s.close} prev=${s.prevClose})`).join(', '),
      );
    }
  } catch (err) {
    console.warn('[IntradayCache] limit-up consistency check failed:', err);
  }

  const json = JSON.stringify(snapshot);
  const key = blobKey(snapshot.market, snapshot.date);
  const filename = localFilename(snapshot.market, snapshot.date);

  if (IS_VERCEL) {
    await blobPut(key, json);
  }

  // 也寫本地（開發用 + Vercel warm instance）
  try {
    await fsPut(filename, json);
  } catch {
    // Vercel 只讀目錄，忽略
  }

  // 更新 memory cache
  const cacheKey = `intraday:${snapshot.market}:${snapshot.date}`;
  globalCache.set(cacheKey, snapshot, MEMORY_TTL);
}

/**
 * 讀取全市場盤中快照
 * 優先 memory cache → Blob → 本地檔案
 */
export async function readIntradaySnapshot(
  market: 'TW' | 'CN',
  date: string,
): Promise<IntradaySnapshot | null> {
  // Memory cache
  const cacheKey = `intraday:${market}:${date}`;
  const cached = globalCache.get<IntradaySnapshot>(cacheKey);
  if (cached) return cached;

  let raw: string | null = null;

  if (IS_VERCEL) {
    raw = await blobGet(blobKey(market, date));
  }

  if (!raw) {
    raw = await fsGet(localFilename(market, date));
  }

  if (!raw) return null;

  try {
    const snapshot: IntradaySnapshot = JSON.parse(raw);
    globalCache.set(cacheKey, snapshot, MEMORY_TTL);
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * 判斷快照是否足夠新鮮（用於決定是否需要重新抓取）
 * @param maxAgeMs 最大允許年齡（毫秒），預設 120000 (2 分鐘)
 */
export function isSnapshotFresh(snapshot: IntradaySnapshot | null, maxAgeMs = 120_000): boolean {
  if (!snapshot) return false;
  const age = Date.now() - new Date(snapshot.updatedAt).getTime();
  return age < maxAgeMs;
}

/** 扁平根門檻：> 90% 的有效報價都是 O=H=L=C 且量=0 即視為退化。正常盤中 < 1%（停牌/整日鎖漲停少數檔），
 *  盤前集合競價 / 刷新凍結會衝到 ~100% → 門檻有極大餘裕，不會誤擋正常快照。 */
export const FLAT_DEGENERATE_FRACTION = 0.9;

/**
 * 快照「退化」偵測：盤前集合競價、或盤中刷新失敗凍結時，所有報價會塌成「扁平根」
 * （O=H=L=C、量=0）—— 只有最後撮合價、沒有真實盤中高低量。把這種快照當「今日那根」餵進三色，
 * 捕撈動能 X1=(2C+H+L)/3 在 H=L=C 時被墊高，會憑空生出假金叉/死叉 → 假底反（2026-06-09 實例：
 * 早盤 DNS 斷線害 L2 凍在 09:17 盤前，3064 檔全扁平，盤中三色誤標 37 檔底反，走圖卻無金叉）。
 *
 * 盤中三色 cron 偵測到就跳過，不用壞快照算訊號、也不覆蓋上一份好的盤中結果。
 * 純看「報價內容」而非 updatedAt：凍結快照的 date 仍是今日、會通過 isSnapshotFresh 以外的日期檢查，
 * 唯有「扁平根占比」能抓出它沒有真實 OHLC。
 * @returns 退化原因字串（cron 用來回報並跳過）；正常則 null。
 */
export function degenerateSnapshotReason(snapshot: IntradaySnapshot | null): string | null {
  if (!snapshot) return 'snapshot 不存在';
  const live = snapshot.quotes.filter((q) => q.close > 0);
  if (live.length === 0) return 'snapshot 無有效報價（全停牌/空）';
  const flat = live.filter((q) => q.open === q.high && q.high === q.low && q.low === q.close && !q.volume).length;
  const flatFrac = flat / live.length;
  if (flatFrac > FLAT_DEGENERATE_FRACTION) {
    return `flat-dominated ${(flatFrac * 100).toFixed(1)}%（O=H=L=C、量=0 的盤前/凍結快照，無真實盤中 OHLC）`;
  }
  return null;
}

// ── Fetch & Build ───────────────────────────────────────────────────────────

/**
 * 從即時 API 抓取並寫入全市場快照
 * TW: TWSE mis + TPEx
 * CN: EastMoney push2
 */
const _refreshInflight = new Map<string, Promise<IntradaySnapshot>>();

export async function refreshIntradaySnapshot(market: 'TW' | 'CN'): Promise<IntradaySnapshot> {
  // Inflight 保護：避免 cron + scanner/coarse + DabanScanner 併發呼叫時
  // 並行 fetch 全市場 + 並行寫同一檔案（0424 L2 JSON 尾巴重複根因之一）。
  // 同一 (market) inflight 中時，後到的 caller 等同一個 promise。
  const existing = _refreshInflight.get(market);
  if (existing) return existing;
  // 最外層再設硬期限：即使未來新增的 provider 忘了設 timeout，single-flight 也不會永久中毒。
  const promise = withIntradayTimeout(
    _refreshIntradaySnapshotImpl(market),
    REFRESH_HARD_TIMEOUT_MS,
    `${market} intraday refresh`,
  );
  _refreshInflight.set(market, promise);
  try {
    return await promise;
  } finally {
    _refreshInflight.delete(market);
  }
}

async function _refreshIntradaySnapshotImpl(market: 'TW' | 'CN'): Promise<IntradaySnapshot> {
  // 記錄嘗試時間（不論成功或失敗），讓 health API 區分 cron 沒跑 vs API 掛了
  _lastRefreshAttempt[market] = new Date().toISOString();

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
  }).format(new Date());

  // 非交易日守門：週末/假日呼叫 refresh 只會拿到前一日盤後資料
  // 若標成 today 寫入 L2，走圖會顯示假的「今日 K 棒」（實為前日重複）
  if (!isTradingDay(today, market)) {
    console.info(`[IntradayCache] ${market} ${today} 非交易日，不刷新 L2`);
    const existing = await readIntradaySnapshot(market, today);
    return existing ?? { market, date: today, updatedAt: new Date().toISOString(), count: 0, quotes: [] };
  }

  const sources: DataSourceStatus[] = [];
  let quotes: IntradayQuote[];

  if (market === 'TW') {
    quotes = await _fetchTWQuotes(sources);
  } else {
    quotes = await _fetchCNQuotes(sources, today);
  }

  // 記錄本次數據源狀態
  _lastSourceStatus[market] = sources;

  // ── 空快照保護 + API 失敗 ≠ 休市 判斷 ──
  if (quotes.length === 0) {
    const tradingDay = isTradingDay(today, market);

    if (tradingDay) {
      // ★ 重試策略：連續失敗 < 2 次才重試，避免重試風暴觸發上游 WAF（mis.twse 2026-04-20 教訓）
      const currentEmpty = _consecutiveEmptyCount[market];
      console.error(
        `[IntradayCache] ★ ${market} 交易日 ${today} 所有數據源返回 0 筆！` +
        `連續第 ${currentEmpty + 1} 次。` +
        `數據源狀態: ${JSON.stringify(sources.map(s => `${s.source}:${s.success}/${s.quoteCount}`))}`
      );

      if (currentEmpty < 2) {
        // 第一輪失敗：指數退避（10s, 30s）
        const backoffMs = currentEmpty === 0 ? 10_000 : 30_000;
        console.info(`[IntradayCache] ${market} 退避 ${backoffMs / 1000}s 後重試（consecutive=${currentEmpty}）`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));

        const retrySources: DataSourceStatus[] = [];
        const retryQuotes = market === 'TW'
          ? await _fetchTWQuotes(retrySources)
          : await _fetchCNQuotes(retrySources, today);

        for (const s of retrySources) {
          sources.push({ ...s, source: `${s.source}(retry)` });
        }
        _lastSourceStatus[market] = sources;

        if (retryQuotes.length > 0) {
          console.info(`[IntradayCache] ${market} 重試成功: ${retryQuotes.length} 筆`);
          quotes = retryQuotes;
          _consecutiveEmptyCount[market] = 0;
        } else {
          _consecutiveEmptyCount[market]++;
          console.error(
            `[IntradayCache] ★★ ${market} 重試仍然 0 筆！` +
            `連續空快照 ${_consecutiveEmptyCount[market]} 次。` +
            `這是 API 故障，不是休市！`
          );
        }
      } else {
        // 連續失敗 ≥ 2 次：跳過重試，讓 existing L2 fallback 接手，避免觸發更嚴 WAF
        _consecutiveEmptyCount[market]++;
        console.warn(
          `[IntradayCache] ${market} 連續空 ${_consecutiveEmptyCount[market]} 次，跳過重試避免 WAF 升級，` +
          `改由 existing L2 fallback 處理`
        );
      }
    } else {
      // 非交易日 → 正常行為，不算 API 故障
      console.info(`[IntradayCache] ${market} ${today} 非交易日，API 返回 0 筆為預期行為`);
      _consecutiveEmptyCount[market] = 0;
    }
  } else {
    // 有數據 → 重置連續空計數 + 記錄成功時間（watchdog 用）
    _consecutiveEmptyCount[market] = 0;
    _lastRefreshSuccess[market] = new Date().toISOString();
  }

  // ── 最終快照保護（空數據 + 部分數據都要擋） ──
  // 2026-05-07 修：CN 1500 → 2800（CN 完整 3062 的 ~92%），TW 500 → 1700（TW 完整 1956 的 ~87%）
  // 原因：partial snapshot 不能蓋掉前一輪 fresh existing
  // - CN：EastMoney 偶爾只回 2262（少 000/001 段 800 支）
  // - TW：OpenAPI 偶爾只回 1500-1900，原 500 門檻形同虛設
  const minExpected = market === 'CN' ? 2800 : 1700;
  const existing = quotes.length < minExpected
    ? await readIntradaySnapshot(market, today)
    : null;

  // age 檢查：existing 快照太舊就不當作 fallback 用（避免盤中用 2 小時前的 L2 跑出假掃描結果）
  const EXISTING_MAX_AGE_MS = 30 * 60 * 1000; // 30 分鐘
  const existingAgeMs = existing
    ? Date.now() - new Date(existing.updatedAt).getTime()
    : Infinity;
  const existingFresh = existing && existing.quotes.length > 0 && existingAgeMs < EXISTING_MAX_AGE_MS;

  if (quotes.length === 0) {
    if (existingFresh) {
      console.warn(
        `[IntradayCache] 保留現有快照 (${existing!.quotes.length} 筆, age ${Math.round(existingAgeMs / 1000)}s)，不覆蓋空數據`
      );
      return existing!;
    }
    if (existing && existing.quotes.length > 0) {
      console.warn(
        `[IntradayCache] 現有快照過舊（age ${Math.round(existingAgeMs / 1000)}s > 30min），` +
        `放棄 fallback，返回空快照讓上層 alert`
      );
    } else {
      console.warn(`[IntradayCache] ${market} 無現有快照且無數據，跳過寫入磁碟`);
    }
    return { market, date: today, updatedAt: new Date().toISOString(), count: 0, quotes: [] };
  }

  // ── 部分數據保護（2026-07-02 強化，連兩天病根修正）──
  // 新抓量低於健康門檻(minExpected) 且 現有快照更完整 → 一律保留現有，「不看 age」。
  //   為什麼不看 age：盤後最終那次抓常只回半套（如 2026-07-01 的 897/2092），此時
  //   盤中最後一筆好快照必然已 >30min，舊的 existingFresh(age<30min) gate 會失效放行 →
  //   好的整套被壞的半套覆蓋，題材/掃描全出現一片「—」。
  //   規則對稱安全：新抓若「多於」現有(改善/次日開盤 bootstrap) 仍照常寫入。
  if (existing && quotes.length < minExpected && existing.quotes.length > quotes.length) {
    console.warn(
      `[IntradayCache] ⚠️ ${market} 新抓 ${quotes.length} 檔 < 健康門檻 ${minExpected} 且少於現有 ${existing.quotes.length} 檔，` +
      `保留現有快照不覆蓋（age ${Math.round(existingAgeMs / 1000)}s）`
    );
    return existing;
  }

  // ── 部分數據保護（原規則保留）：新數據 < 現有的 30% 且 existing 仍 fresh → 保留現有 ──
  if (existingFresh && quotes.length < existing!.quotes.length * 0.3) {
    console.warn(
      `[IntradayCache] ⚠️ ${market} 新數據嚴重不足（${quotes.length} vs 現有 ${existing!.quotes.length}, age ${Math.round(existingAgeMs / 1000)}s），` +
      `保留現有快照，不覆蓋`
    );
    return existing!;
  }

  const snapshot: IntradaySnapshot = {
    market,
    date: today,
    updatedAt: new Date().toISOString(),
    count: quotes.length,
    quotes,
  };

  await writeIntradaySnapshot(snapshot);

  // ── L2 交叉核驗：抽樣 50 支比對備用源 ──
  try {
    await withIntradayTimeout(
      crossValidateL2(market, quotes, sources),
      CROSS_VALIDATE_TIMEOUT_MS,
      `${market} L2 cross validation`,
    );
  } catch (err) {
    console.warn(`[IntradayCache] ${market} 交叉核驗失敗 (non-fatal):`, err);
  }

  console.info(`[IntradayCache] ${market} 快照已更新: ${quotes.length} 檔 @ ${today}`);
  return snapshot;
}

/**
 * 取得本次刷新的摘要（供 cron 端點回傳）
 */
export function getLastRefreshSummary(market: 'TW' | 'CN'): L2RefreshSummary {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
  }).format(new Date());
  const trading = isTradingDay(today, market);
  const empty = _consecutiveEmptyCount[market] ?? 0;

  let alertLevel: L2RefreshSummary['alertLevel'] = 'none';
  if (trading && empty >= 3) alertLevel = 'critical';
  else if (trading && empty >= 1) alertLevel = 'warning';

  return {
    sources: _lastSourceStatus[market] ?? [],
    consecutiveEmptyCount: empty,
    isTradingDayFlag: trading,
    alertLevel,
  };
}

// ── 內部：TW 報價抓取（mis → OpenAPI 兩層 failover） ───────────────────────

async function _fetchTWQuotes(sources: DataSourceStatus[]): Promise<IntradayQuote[]> {
  const finalMap: Map<string, { code: string; name: string; open: number; high: number; low: number; close: number; volume: number; previousClose?: number; date?: string; isActualTrade?: boolean }> = new Map();

  type TWProvider = { name: string; fetch: () => Promise<typeof finalMap> };
  const providers: TWProvider[] = [
    {
      name: 'TWSE+TPEx(mis)',
      fetch: async () => {
        const { getTWSERealtimeIntraday } = await import('./TWSERealtime');
        return getTWSERealtimeIntraday();
      },
    },
    {
      name: 'TWSE+TPEx(OpenAPI)',
      fetch: async () => {
        const { getTWSEDailyAll } = await import('./TWSERealtime');
        return getTWSEDailyAll();
      },
    },
  ];

  for (const p of providers) {
    if (finalMap.size >= TW_SUCCESS_MIN) break;

    const skipUntil = shouldSkipSource(p.name);
    if (skipUntil) {
      const remain = Math.round((skipUntil - Date.now()) / 1000);
      console.warn(`[IntradayCache] TW ${p.name} 在失敗冷卻中（剩 ${remain}s），跳過`);
      sources.push({
        source: p.name,
        success: false,
        quoteCount: 0,
        errorMessage: `skip: failed < ${SOURCE_SKIP_WINDOW_MS / 1000}s ago`,
        responseTimeMs: 0,
        timestamp: new Date().toISOString(),
      });
      continue;
    }

    try {
      const { result: newMap, elapsedMs } = await timedFetch(p.fetch);
      let added = 0;
      for (const [code, q] of newMap) {
        if (!finalMap.has(code)) {
          finalMap.set(code, q);
          added++;
        }
      }
      // 2026-05-07：對齊 CN 修正 — partial 不算 failed
      // 避免 OpenAPI 拿 1900 筆（< 1916）就標 failed 進冷卻、第二輪只剩 mis 一條備援
      const success = newMap.size > 0;
      sources.push({
        source: p.name,
        success,
        quoteCount: newMap.size,
        responseTimeMs: elapsedMs,
        timestamp: new Date().toISOString(),
      });
      if (success) {
        markSourceSucceeded(p.name);
      } else {
        markSourceFailed(p.name);
      }
      console.info(`[IntradayCache] TW ${p.name}: ${newMap.size} 筆（新增 ${added}，累計 ${finalMap.size}, ${elapsedMs}ms）`);
    } catch (err) {
      markSourceFailed(p.name);
      sources.push({
        source: p.name,
        success: false,
        quoteCount: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
        responseTimeMs: 0,
        timestamp: new Date().toISOString(),
      });
      console.warn(`[IntradayCache] TW ${p.name} 失敗:`, err instanceof Error ? err.message : err);
    }
  }

  if (finalMap.size < TW_SUCCESS_MIN) {
    console.warn(`[IntradayCache] TW 兩層 provider 後仍 ${finalMap.size} 筆 (< ${TW_SUCCESS_MIN})，回傳部分資料`);
  }

  // 日期守門：STOCK_DAY_ALL 盤中會回傳昨日收盤統計（q.date=昨天），
  // 若不檢查就會把昨日 OHLC 當成今日報價寫入 L2，污染所有下游掃描。
  // 盤後（15:00+）STOCK_DAY_ALL 填入當日收盤（q.date=今天），正常放行。
  const todayTW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  let staleSkipped = 0;
  const quotes: IntradayQuote[] = [];
  for (const [, q] of finalMap) {
    if (q.date && q.date !== todayTW) {
      staleSkipped++;
      continue; // 丟掉非今日資料（STOCK_DAY_ALL 盤中回傳的昨日殘留）
    }
    const prevClose = q.previousClose ?? q.close;
    const changePercent = prevClose > 0 ? ((q.close - prevClose) / prevClose) * 100 : 0;
    quotes.push({
      symbol: q.code,
      name: q.name,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume,
      prevClose,
      changePercent: Math.round(changePercent * 100) / 100,
      isActualTrade: q.isActualTrade,
    });
  }
  if (staleSkipped > 0) {
    console.warn(`[IntradayCache] TW 丟棄 ${staleSkipped} 筆非 ${todayTW} 資料（多半是 STOCK_DAY_ALL 盤中昨日殘留）`);
  }

  // 台股兩個大盤指數 ^TWII / ^TWOII — 跟個股共用同一個 L2 snapshot，
  // 下游 append-from-snapshot 會自動寫 L1。
  // 0518 修：原本 ^TWII 只能靠 Vercel cron `download-candles-batch?batch=1` 走 Yahoo 抓
  // (本地 launchd 沒涵蓋、Yahoo 當日 vol 還會回 0)，現在改從 mis.twse t00 一起進 L2。
  const twIndices = await Promise.all([
    fetchTWIndexQuote(todayTW, '^TWII'),
    fetchTWIndexQuote(todayTW, '^TWOII'),
  ]);
  for (const indexQuote of twIndices) if (indexQuote) quotes.push(indexQuote);

  return quotes;
}

// ── 大盤指數抓取 (^TWII / 000001.SS) ─────────────────────────────────────────
// 指數從 vendor 即時 API 抓回後 push 進 L2 snapshot quotes[]，
// append-from-snapshot 在 indices 處理區塊撈出來寫 L1（symbol 帶 suffix 避免跟個股 code 撞）。

const MIS_HEADERS_INDEX = {
  Accept: '*/*',
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://mis.twse.com.tw/stock/',
};

export async function fetchTWIndexQuote(
  todayTW: string,
  symbol: '^TWII' | '^TWOII' = '^TWII',
): Promise<IntradayQuote | null> {
  try {
    const channel = symbol === '^TWII' ? 'tse_t00.tw' : 'otc_o00.tw';
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${channel}&json=1&delay=0&_=${Date.now()}`;
    const res = await fetch(url, { headers: MIS_HEADERS_INDEX, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = await res.json() as { msgArray?: Array<Record<string, string>> };
    const d = json.msgArray?.[0];
    if (!d) return null;
    const close = parseFloat(d.z ?? '');
    if (!(close > 0)) return null; // 盤前/休市 z='-'
    const open = parseFloat(d.o ?? '') || close;
    const high = parseFloat(d.h ?? '') || close;
    const low = parseFloat(d.l ?? '') || close;
    const prevClose = parseFloat(d.y ?? '') || close;
    // mis.twse 對 t00 指數**只有 m（累計成交量，張）沒有 v**（個股用 v）
    let volume = parseInt((d.m ?? d.v ?? '0').replace(/,/g, ''), 10) || 0;
    // 收盤後改用 TWSE 官方 FMTQIK 成交股數（2026-07-23）：mis 的 m 比官方少 ~1%
    // （盤後定價交易沒算進去），而 append-from-snapshot 寫進 L1 後沒有人會再覆寫它
    //（download-candles-batch 看 lastDate 已是今天就 skip）→ 誤差會永久留在 L1。
    // 官方要收盤後才發，盤中查無 → 保留 mis 的 m。
    if (symbol === '^TWII') {
      try {
        const { fetchTwseMarketStatsMonth } = await import('./TwseMarketStats');
        const stats = await fetchTwseMarketStatsMonth(todayTW.slice(0, 4) + todayTW.slice(5, 7));
        const official = stats.get(todayTW);
        if (official && official.volume > 0) volume = official.volume;
      } catch { /* fail-open：官方站掛掉就用 mis 的 m */ }
    }
    // 日期守門：mis d.d 是當前報價日期（盤前可能是上一交易日），不是 today 就丟
    const misDate = d.d ? `${d.d.slice(0, 4)}-${d.d.slice(4, 6)}-${d.d.slice(6, 8)}` : todayTW;
    if (misDate !== todayTW) {
      console.warn(`[IntradayCache] ${symbol} mis.twse 回 ${misDate} ≠ today ${todayTW}，丟棄`);
      return null;
    }
    const changePercent = prevClose > 0 ? Math.round(((close - prevClose) / prevClose) * 10000) / 100 : 0;
    return {
      symbol,
      name: d.n?.trim() || (symbol === '^TWII' ? '發行量加權股價指數' : '櫃買指數'),
      open,
      high,
      low,
      close,
      volume,
      prevClose,
      changePercent,
    };
  } catch (err) {
    console.warn(`[IntradayCache] ${symbol} fetch 失敗:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// 抓陸股指數即時報價（上證 / 深證成指）。三色 RS 基準：滬市股用上證、深市股用深證成指。
async function fetchCNIndexQuote(
  todayCN: string,
  tencentCode = 'sh000001',
  symbol = '000001.SS',
  defName = '上證指數',
): Promise<IntradayQuote | null> {
  try {
    const url = `https://qt.gtimg.cn/q=${tencentCode}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    // Tencent 回 GBK；指數欄位跟個股結構一致
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const match = text.match(/="([^"]+)"/);
    if (!match) return null;
    const parts = match[1].split('~');
    if (parts.length < 35) return null;
    const name = parts[1];
    const close = parseFloat(parts[3]);
    if (!(close > 0)) return null;
    const prevClose = parseFloat(parts[4]) || close;
    const open = parseFloat(parts[5]) || close;
    const high = parseFloat(parts[33]) || close;
    const low = parseFloat(parts[34]) || close;
    const volume = (parseFloat(parts[6]) || 0) * 100; // 手→股，對齊既有 L1
    // 日期守門：parts[30] 格式 YYYYMMDDHHMMSS
    if (parts[30] && parts[30].length >= 8) {
      const ts = parts[30];
      const tsDate = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
      if (tsDate !== todayCN) {
        console.warn(`[IntradayCache] ${symbol} tencent 回 ${tsDate} ≠ today ${todayCN}，丟棄`);
        return null;
      }
    }
    const changePercent = prevClose > 0 ? Math.round(((close - prevClose) / prevClose) * 10000) / 100 : 0;
    return {
      symbol,
      name: name || defName,
      open,
      high,
      low,
      close,
      volume,
      prevClose,
      changePercent,
    };
  } catch (err) {
    console.warn(`[IntradayCache] ${symbol} fetch 失敗:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── 內部：CN 報價抓取（EastMoney → Tencent → Sina 三層 failover） ──────────

type CNQuoteMap = Map<string, { code: string; name: string; open: number; high: number; low: number; close: number; volume: number; prevClose?: number }>;

async function _fetchCNQuotes(
  sources: DataSourceStatus[],
  today: string,
): Promise<IntradayQuote[]> {
  const cnMap: CNQuoteMap = new Map();
  // 三層 provider：主源 → 補 → 補，任何一層到達 98% 就停止
  type CNProvider = { name: string; fetch: () => Promise<CNQuoteMap> };
  const { CN_STOCKS } = await import('@/lib/scanner/cnStocks');
  const symbols = CN_STOCKS.map(s => s.symbol);

  // 2026-05-07：Tencent 升主源、EastMoney 降備援
  // 實測 5/07 對比：Tencent 3062 筆 / 1.4s 完整；EastMoney 1281 筆 / 65.7s 偏 partial。
  // EastMoney push2 對台灣/海外 IP 越來越不穩，Tencent 的批次端點目前更可靠。
  // 若哪天 Tencent 也不穩，仍會自動 fallback 到 EastMoney → Sina。
  const providers: CNProvider[] = [
    {
      name: 'Tencent',
      fetch: async () => {
        const { getTencentRealtime } = await import('./TencentRealtime');
        return getTencentRealtime(symbols);
      },
    },
    {
      name: 'EastMoney',
      fetch: async () => {
        const { getEastMoneyRealtime } = await import('./EastMoneyRealtime');
        return getEastMoneyRealtime();
      },
    },
    {
      name: 'Sina',
      fetch: async () => {
        const { getSinaRealtime } = await import('./SinaRealtime');
        return getSinaRealtime(symbols);
      },
    },
  ];

  for (const p of providers) {
    if (cnMap.size >= CN_SUCCESS_MIN) break;

    const skipUntil = shouldSkipSource(p.name);
    if (skipUntil) {
      const remain = Math.round((skipUntil - Date.now()) / 1000);
      console.warn(`[IntradayCache] CN ${p.name} 在失敗冷卻中（剩 ${remain}s），跳過`);
      sources.push({
        source: p.name,
        success: false,
        quoteCount: 0,
        errorMessage: `skip: failed < ${SOURCE_SKIP_WINDOW_MS / 1000}s ago`,
        responseTimeMs: 0,
        timestamp: new Date().toISOString(),
      });
      continue;
    }

    try {
      const { result: newMap, elapsedMs } = await timedFetch(p.fetch);
      // 合併（保留既有，不覆蓋先前 provider 已填過的欄位較豐富的報價）
      let added = 0;
      for (const [code, q] of newMap) {
        if (!cnMap.has(code)) {
          cnMap.set(code, q);
          added++;
        }
      }
      // 2026-05-07 修：partial 不算 failed
      // 原舊邏輯：< CN_SUCCESS_MIN(3000) 就標 failed → EastMoney 拿 2262 (74%) 也算失敗
      // → 進 60s 冷卻 + 後續輪也持續被 partial 困住 → snapshot 永遠卡 2262
      // 新邏輯：只要拿到 > 0 就算 source 成功；下游靠 cnMap.size 判斷整體完整性，
      // partial 還是會繼續 fallback 到 Tencent / Sina 補完缺的 symbol
      const success = newMap.size > 0;
      sources.push({
        source: p.name,
        success,
        quoteCount: newMap.size,
        responseTimeMs: elapsedMs,
        timestamp: new Date().toISOString(),
      });
      if (success) {
        markSourceSucceeded(p.name);
      } else {
        markSourceFailed(p.name);
      }
      console.info(`[IntradayCache] CN ${p.name}: ${newMap.size} 筆（新增 ${added}，累計 ${cnMap.size}, ${elapsedMs}ms）`);
    } catch (err) {
      markSourceFailed(p.name);
      sources.push({
        source: p.name,
        success: false,
        quoteCount: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
        responseTimeMs: 0,
        timestamp: new Date().toISOString(),
      });
      console.warn(`[IntradayCache] CN ${p.name} 失敗:`, err instanceof Error ? err.message : err);
    }
  }

  if (cnMap.size < CN_SUCCESS_MIN) {
    // 2026-05-07：加 prefix 診斷，缺哪一段一目了然
    const prefix: Record<string, number> = {};
    for (const code of cnMap.keys()) {
      const p = code.slice(0, 3);
      prefix[p] = (prefix[p] ?? 0) + 1;
    }
    console.warn(
      `[IntradayCache] CN 三層 provider 後仍 ${cnMap.size} 筆 (< ${CN_SUCCESS_MIN})，回傳部分資料` +
      ` prefix=${JSON.stringify(prefix)}`
    );
  }

  // 3. 讀取 MA Base 以補足 prevClose
  const maBaseMap: Record<string, { closes: number[] }> = {};
  try {
    const maBase = await readMABase('CN', today);
    if (maBase) {
      for (const [sym, entry] of Object.entries(maBase.data)) {
        if (entry.closes.length > 0) {
          maBaseMap[sym] = { closes: entry.closes };
        }
      }
    }
  } catch { /* ignore - MA base 尚不存在 */ }

  // 4. 組裝報價
  const quotes: IntradayQuote[] = [];
  for (const [, q] of cnMap) {
    const ma = maBaseMap[q.code];
    const prevClose = q.prevClose ?? ma?.closes[ma.closes.length - 1] ?? q.close;
    const changePercent = prevClose > 0
      ? Math.round(((q.close - prevClose) / prevClose) * 10000) / 100
      : 0;
    quotes.push({
      symbol: q.code,
      name: q.name,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume,
      prevClose,
      changePercent,
    });
  }

  if (quotes.length > 0) {
    const src = sources.find(s => s.success)?.source ?? 'unknown';
    console.info(`[IntradayCache] CN L2 來源: ${src}, ${quotes.length} 筆`);
  }

  // 大盤指數併入 L2 snapshot：上證(000001.SS)=滬市 RS 基準、深證成指(399001.SZ)=深市 RS 基準。
  // symbol 帶 .SS/.SZ 後綴避免與個股撞 key（000001.SZ 平安銀行 / 399001 等）。
  const cnIndexSH = await fetchCNIndexQuote(today, 'sh000001', '000001.SS', '上證指數');
  if (cnIndexSH) quotes.push(cnIndexSH);
  const cnIndexSZ = await fetchCNIndexQuote(today, 'sz399001', '399001.SZ', '深證成指');
  if (cnIndexSZ) quotes.push(cnIndexSZ);

  return quotes;
}

// ── MA Base (歷史尾端快取) ──────────────────────────────────────────────────

export interface MABaseEntry {
  /** 最近 N 根收盤價（由舊到新） */
  closes: number[];
  /** 最近 N 根成交量（由舊到新） */
  volumes: number[];
}

export interface MABaseSnapshot {
  market: 'TW' | 'CN';
  date: string;           // 最後封存日期
  updatedAt: string;
  /** symbol → MABaseEntry */
  data: Record<string, MABaseEntry>;
}

function maBaseBlobKey(market: 'TW' | 'CN', date: string): string {
  return `intraday/${market}/${date}-ma-base.json`;
}

function maBaseLocalFilename(market: 'TW' | 'CN', date: string): string {
  return `intraday-${market}-${date}-ma-base.json`;
}

/**
 * 寫入 MA Base（收盤 cron 時呼叫）
 */
export async function writeMABase(base: MABaseSnapshot): Promise<void> {
  const json = JSON.stringify(base);
  if (IS_VERCEL) {
    await blobPut(maBaseBlobKey(base.market, base.date), json);
  }
  try {
    await fsPut(maBaseLocalFilename(base.market, base.date), json);
  } catch { /* ignore */ }

  const cacheKey = `mabase:${base.market}:${base.date}`;
  globalCache.set(cacheKey, base, 24 * 60 * 60 * 1000); // 24 小時
}

/**
 * 讀取 MA Base
 */
export async function readMABase(
  market: 'TW' | 'CN',
  date: string,
): Promise<MABaseSnapshot | null> {
  const cacheKey = `mabase:${market}:${date}`;
  const cached = globalCache.get<MABaseSnapshot>(cacheKey);
  if (cached) return cached;

  let raw: string | null = null;
  if (IS_VERCEL) {
    raw = await blobGet(maBaseBlobKey(market, date));
  }
  if (!raw) {
    raw = await fsGet(maBaseLocalFilename(market, date));
  }
  if (!raw) return null;

  try {
    const base: MABaseSnapshot = JSON.parse(raw);
    globalCache.set(cacheKey, base, 24 * 60 * 60 * 1000);
    return base;
  } catch {
    return null;
  }
}

// ── L2 交叉核驗 ──────────────────────────────────────────────────────────

export interface CrossValidationResult {
  sampleSize: number;
  matched: number;
  mismatched: number;
  mismatchRate: number;
  suspicious: boolean;
  details: { symbol: string; primary: number; secondary: number; diffPct: number }[];
}

/** 最近一次交叉核驗結果 */
const _lastCrossValidation: Record<string, CrossValidationResult> = {};

export function getLastCrossValidation(market: 'TW' | 'CN'): CrossValidationResult | null {
  return _lastCrossValidation[market] ?? null;
}

const CROSS_VALIDATE_SAMPLE = 50;
const CROSS_VALIDATE_TOLERANCE = 0.02; // 2% 偏差容忍
const CROSS_VALIDATE_ALERT_THRESHOLD = 0.10; // 10% 不一致率觸發告警

/**
 * 從備用源抽樣比對，驗證主源數據正確性
 * TW: 主源 mis.twse vs 備源 OpenAPI
 * CN: 主源東財 vs 備源騰訊
 */
async function crossValidateL2(
  market: 'TW' | 'CN',
  primaryQuotes: IntradayQuote[],
  _sources: DataSourceStatus[],
): Promise<void> {
  if (primaryQuotes.length < 100) return; // 數據太少不值得核驗

  // 抽樣：隨機選 50 支
  const shuffled = [...primaryQuotes].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, CROSS_VALIDATE_SAMPLE);
  const primaryMap = new Map(sample.map(q => [q.symbol, q.close]));

  // 從備用源獲取相同股票的報價
  let secondaryMap: Map<string, number>;
  try {
    if (market === 'TW') {
      const { getTWSEDailyAll } = await import('./TWSERealtime');
      const dailyMap = await getTWSEDailyAll();
      secondaryMap = new Map();
      for (const [, q] of dailyMap) {
        secondaryMap.set(q.code, q.close);
      }
    } else {
      const { getTencentRealtime } = await import('./TencentRealtime');
      const symbols = sample.map(q => q.symbol);
      const tcMap = await getTencentRealtime(symbols);
      secondaryMap = new Map();
      for (const [code, q] of tcMap) {
        secondaryMap.set(code, q.close);
      }
    }
  } catch {
    // 備用源不可用，跳過核驗
    return;
  }

  // 比對
  let matched = 0;
  let mismatched = 0;
  const details: CrossValidationResult['details'] = [];

  for (const [symbol, primaryClose] of primaryMap) {
    const secondaryClose = secondaryMap.get(symbol);
    if (!secondaryClose || secondaryClose <= 0 || primaryClose <= 0) continue;

    const diffPct = Math.abs(primaryClose - secondaryClose) / primaryClose;
    if (diffPct <= CROSS_VALIDATE_TOLERANCE) {
      matched++;
    } else {
      mismatched++;
      details.push({
        symbol,
        primary: primaryClose,
        secondary: secondaryClose,
        diffPct: Math.round(diffPct * 10000) / 100,
      });
    }
  }

  const total = matched + mismatched;
  if (total === 0) return;

  const mismatchRate = mismatched / total;
  const suspicious = mismatchRate > CROSS_VALIDATE_ALERT_THRESHOLD;

  const result: CrossValidationResult = {
    sampleSize: total,
    matched,
    mismatched,
    mismatchRate: Math.round(mismatchRate * 100) / 100,
    suspicious,
    details: details.slice(0, 10), // 最多記錄 10 筆
  };

  _lastCrossValidation[market] = result;

  if (suspicious) {
    // 2026-05-08：降為 warn — TW 用 mis (即時) vs TWSEDailyAll (盤後) 對比，
    // 盤中本來就會差異，不該觸發 production error alert。
    // 真實源頭錯誤會由 consecutiveEmptyCount 跟 download verifier 抓到。
    console.warn(
      `[IntradayCache] ${market} L2 交叉核驗偏差較大: ` +
      `${mismatched}/${total} 支偏差 > 2%（不一致率 ${(mismatchRate * 100).toFixed(1)}%）— ` +
      `盤中 mis vs 盤後 daily 對比常態差異，不一定是 bug`
    );
  } else {
    console.info(
      `[IntradayCache] ${market} L2 交叉核驗通過: ${matched}/${total} 一致`
    );
  }
}
