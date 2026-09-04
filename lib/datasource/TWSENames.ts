/**
 * TWSENames.ts — 台灣上市/上櫃股票中文名稱快取查詢
 *
 * 從 TWSE / TPEx OpenAPI 取得全市場股票代號 → 中文名稱對照表，
 * 快取 24 小時，讓個股資料 API 可以補上中文公司名。
 */

import fs from 'fs';
import path from 'path';
import { globalCache } from './MemoryCache';
import { CN_STOCKS } from '@/lib/scanner/cnStocks';

/** A 股代號 → 中文名靜態對照表（從 ChinaScanner 清單建立） */
const CN_NAME_MAP: Record<string, string> = Object.fromEntries(
  CN_STOCKS.map(s => [s.symbol.replace(/\.(SS|SZ)$/i, ''), s.name]),
);

/** 檔案快取路徑（持久化動態查詢到的名稱，避免重啟後重查） */
const CN_FILE_CACHE = path.join(process.cwd(), '.cache', 'cn-names.json');

// 啟動時載入檔案快取，補充靜態清單沒有的名稱
try {
  const saved = JSON.parse(fs.readFileSync(CN_FILE_CACHE, 'utf-8')) as Record<string, string>;
  for (const [code, name] of Object.entries(saved)) {
    CN_NAME_MAP[code] ??= name;
  }
} catch { /* 檔案不存在或讀取失敗，忽略 */ }

/**
 * 將動態查詢到的名稱寫回檔案快取
 *
 * 用 in-memory pendingWrites 緩衝 + atomic rename 解決 read-merge-write 並行問題：
 * - 多個並行 persistCNName 呼叫先合併到 pending Map，再 batched flush
 * - flush 時讀檔→merge in-memory→atomic rename 寫回
 * - 同個 process 不會 lose update（單執行緒事件迴圈保證 flush 內 atomic）
 */
const _pendingWrites = new Map<string, string>();
let _flushTimer: NodeJS.Timeout | null = null;

function flushCNNamesPending(): void {
  if (_pendingWrites.size === 0) return;
  try {
    const snapshot = new Map(_pendingWrites);
    _pendingWrites.clear();

    let saved: Record<string, string> = {};
    try { saved = JSON.parse(fs.readFileSync(CN_FILE_CACHE, 'utf-8')); } catch { /* 新檔 */ }

    let dirty = false;
    for (const [code, name] of snapshot) {
      if (saved[code] !== name) { saved[code] = name; dirty = true; }
    }
    if (!dirty) return;

    fs.mkdirSync(path.dirname(CN_FILE_CACHE), { recursive: true });
    // atomic write：先寫 tmp 再 rename，避免 partial write
    const tmp = `${CN_FILE_CACHE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(saved, null, 2), 'utf-8');
    fs.renameSync(tmp, CN_FILE_CACHE);
  } catch { /* 寫入失敗，不影響主流程 */ }
}

function persistCNName(code: string, name: string): void {
  _pendingWrites.set(code, name);
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushCNNamesPending();
  }, 200);  // 200ms 批次 flush
}

/**
 * 查詢 A 股中文名稱（滬市/深市 6 位代號）。
 * 優先查靜態對照表，查無則從東方財富 API 動態取得並快取。
 * @param code  純數字代號，例如 "603986"
 * @returns     中文公司名，若查無則回傳 null
 */
export async function getCNChineseName(code: string, suffix?: 'SS' | 'SZ'): Promise<string | null> {
  // 1. 快取（動態 API 取過的最新名字優先）
  // 注意：suffix 不同代表不同 symbol（000001.SS 上證指數 vs 000001.SZ 平安銀行），需分開快取
  const cacheKey = suffix ? `cn:name:${code}.${suffix}` : `cn:name:${code}`;
  const cached = globalCache.get<string>(cacheKey);
  if (cached) return cached;

  // 2. 靜態對照表（CN_STOCKS + 檔案快取，立即返回不打 API）
  // 大多數主板股票都在 CN_NAME_MAP，直接回傳避免 500 支股票 × 5s API timeout
  // 帶 suffix 時跳過靜態表（因 CN_NAME_MAP 不分 SS/SZ，會誤抓股票名給指數）
  if (!suffix && CN_NAME_MAP[code]) {
    globalCache.set(cacheKey, CN_NAME_MAP[code], 24 * 60 * 60 * 1000);
    return CN_NAME_MAP[code];
  }

  // 3. 東方財富 API 動態查詢（僅靜態清單查無時才打 API）
  try {
    // 北交所（920/8/4 開頭）市場碼一律 0、與滬深無代碼歧義 → 最優先（上游常把 920xxx 誤標 .SS，
    // 落到 1.920xxx 上海會抓空，名字出不來只剩裸代號）。其餘 suffix 權威：SS=上海(1.code)、SZ=深圳(0.code)。
    const secid = /^(92|8|4)/.test(code) ? `0.${code}`
      : suffix === 'SS' ? `1.${code}`
      : suffix === 'SZ' ? `0.${code}`
      : code.startsWith('6') ? `1.${code}` : `0.${code}`;
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f58&_=${Date.now()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const json = await res.json();
      const name = json?.data?.f58;
      if (name && typeof name === 'string') {
        CN_NAME_MAP[code] = name;
        globalCache.set(cacheKey, name, 24 * 60 * 60 * 1000);
        persistCNName(code, name);
        return name;
      }
    }
  } catch { /* 東方財富失敗，嘗試騰訊 */ }

  // 4. 騰訊財經 API（備援，GBK 編碼）
  try {
    const prefix = /^(92|8|4)/.test(code) ? 'bj' : suffix === 'SS' ? 'sh' : suffix === 'SZ' ? 'sz' : code.startsWith('6') ? 'sh' : 'sz';
    const url = `https://qt.gtimg.cn/q=${prefix}${code}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      const match = text.match(/~([^~]+)~/);
      if (match?.[1] && /[一-鿿]/.test(match[1])) {
        const name = match[1];
        // 不帶 suffix 時才寫回 CN_NAME_MAP（避免指數名覆蓋同代碼股票名）
        if (!suffix) {
          CN_NAME_MAP[code] = name;
          persistCNName(code, name);
        }
        globalCache.set(cacheKey, name, 24 * 60 * 60 * 1000);
        return name;
      }
    }
  } catch { /* 騰訊也失敗 */ }

  // 5. 最後 fallback：靜態清單（可能名字過期但總比沒有好；帶 suffix 時跳過避免錯誤）
  return suffix ? null : (CN_NAME_MAP[code] ?? null);
}

const NAMES_CACHE_KEY = 'twse:names:all';
const OTC_SET_CACHE_KEY = 'twse:otc-codes';
const NAMES_TTL       = 24 * 60 * 60 * 1000; // 24 hours

type NameMap = Record<string, string>; // code → Chinese name

// ── 本地 stock-master.json（youtube cron 維護，~23K 筆 code↔name 含 TPEx）────────
// 兩個用途：(1) buildNameMap 網路源被擋時補全 (2) 冷啟動 fast path —— buildNameMap
// 打 TWSE/TPEx/ISIN 最長 30s，但 request 熱路徑名稱預算只有 3s（nameWithTimeout），
// 重啟後第一批 /api/stock 永遠拿不到名字 → 先用本地檔即回，完整 map 背景建好後接手。
interface StockMasterEntry { code: string; name: string; market?: string }

let _stockMasterEntries: StockMasterEntry[] | null | undefined;
function loadStockMasterEntries(): StockMasterEntry[] | null {
  if (_stockMasterEntries !== undefined) return _stockMasterEntries;
  try {
    const smPath = path.join(process.cwd(), 'data', 'youtube', 'stock-master.json');
    const sm = JSON.parse(fs.readFileSync(smPath, 'utf-8')) as { entries?: StockMasterEntry[] };
    _stockMasterEntries = sm.entries?.length ? sm.entries : null;
  } catch {
    _stockMasterEntries = null;
  }
  return _stockMasterEntries;
}

let _localNameMap: NameMap | null | undefined;
function getLocalNameMap(): NameMap | null {
  if (_localNameMap !== undefined) return _localNameMap;
  const entries = loadStockMasterEntries();
  if (!entries) { _localNameMap = null; return null; }
  const m: NameMap = {};
  for (const e of entries) {
    if (e.code && e.name && m[e.code] == null) m[e.code] = e.name;
  }
  _localNameMap = m;
  return m;
}

interface BuildResult {
  map: NameMap;
  otcCodes: Set<string>;
}

async function buildNameMap(): Promise<BuildResult> {
  const map: NameMap = {};
  // 2026-05-21：同時建立上櫃 OTC code 集合，給 TWSEHistProvider.isOTC 用
  // 原本 isOTC 用「.TWO suffix 或 5 位數」啟發式，3236 是 4 位數的上櫃股就誤判為 TSE，
  // 結果歷史 candle 走 Yahoo adjusted close（除息調整），昨收偏離 1 元，漲跌幅算錯。
  const otcCodes = new Set<string>();

  // 先並行抓兩個輕量官方 JSON；只有 TPEx 不可用時才補抓大型 ISIN HTML。
  // 2026-05-14：ISIN 也走 curl fallback — Cloudflare 連 ISIN 的 Node fetch 都會
  // timeout（dev runtime 實測 15s 收不到 byte），但 curl 1.9s 回 2.5MB 887 檔上櫃股全有。
  const { fetchJsonWithCurlFallback, fetchBufferWithCurlFallback } = await import('./curlFetch');
  const [listedRes, otcRes] = await Promise.allSettled([
    fetchJsonWithCurlFallback<{ Code: string; Name: string }[]>(
      'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      { timeoutMs: 10000 },
    ),
    fetchJsonWithCurlFallback<{ SecuritiesCompanyCode: string; CompanyName: string }[]>(
      'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
      { timeoutMs: 10000 },
    ),
  ]);
  // ISIN is a large, slow fallback. Do not start it speculatively when the
  // authoritative TPEx JSON already returned a usable universe.
  const tpexRows = otcRes.status === 'fulfilled' && Array.isArray(otcRes.value.data)
    ? otcRes.value.data
    : [];
  const [isinOtcRes] = tpexRows.length > 0
    ? [null]
    : await Promise.allSettled([fetchBufferWithCurlFallback(
      'https://isin.twse.com.tw/isin/C_public.jsp?strMode=4',
      { timeoutMs: 30000 },
    )]);

  // 代號 regex：4-5 位數字，允許尾巴帶單一字母（ETF 後綴 A/B/T 等，例如 00981A、00981T）
  const CODE_RE = /^\d{4,5}[A-Z]?$/;

  // 上市股票（TWSE STOCK_DAY_ALL，僅含當日有成交的股票）
  let twseAdded = 0;
  if (listedRes.status === 'fulfilled') {
    for (const s of listedRes.value.data) {
      if (CODE_RE.test(s.Code)) { map[s.Code] = s.Name; twseAdded++; }
    }
  } else {
    console.warn('[TWSENames] listedRes rejected:', listedRes.reason);
  }

  // 上櫃股票：優先用 TPEx JSON，被 Cloudflare 擋時用 ISIN HTML 備援
  let tpexAdded = 0;
  let isinUsed = false;
  if (otcRes.status === 'fulfilled') {
    const arr = otcRes.value.data;
    if (Array.isArray(arr) && arr.length > 0) {
      for (const s of arr) {
        if (CODE_RE.test(s.SecuritiesCompanyCode)) {
          if (map[s.SecuritiesCompanyCode] == null) {
            map[s.SecuritiesCompanyCode] = s.CompanyName;
            tpexAdded++;
          }
          // 一定要 mark 為 OTC（不管 map 是否已存在 — TWSE STOCK_DAY_ALL 可能誤收上櫃股當日成交資料）
          otcCodes.add(s.SecuritiesCompanyCode);
        }
      }
    } else {
      console.warn('[TWSENames] otcRes fulfilled but empty:', typeof arr, Array.isArray(arr) ? arr.length : 'not-array');
    }
  } else {
    console.warn('[TWSENames] otcRes rejected:', otcRes.reason);
  }

  // 0514 修：otcRes 即使 fulfilled 也可能空陣列（TPEx 維護中），改用「OTC 結果不足」當條件
  // 而不是「otcRes rejected」，否則 ISIN 備援永遠不會跑到
  if (isinOtcRes?.status === 'rejected') {
    console.warn('[TWSENames] isinOtcRes rejected:', isinOtcRes.reason);
  }
  if (tpexAdded === 0 && isinOtcRes?.status === 'fulfilled') {
    isinUsed = true;
    // ISIN C_public.jsp Big5 HTML（fetchBufferWithCurlFallback 已處理 Node fetch
    // timeout → curl fallback；標準 dev runtime curl 1.9s 回 2.5MB 887 檔）
    try {
      const text = new TextDecoder('big5').decode(isinOtcRes.value.buffer);
      // 0514 修：原 regex 只接受 TW\d{10} ISIN → 漏掉 KY 股（雅特力-KY/AMAX-KY 等
      // 在開曼註冊 ISIN 開頭 KYG...）。改用 [A-Z]{2}\w{10} 接所有 12 字元 ISIN code
      // 涵蓋 TW 上市 + KY/BMG/VG 等海外註冊股。
      for (const [, code, name] of text.matchAll(
        /bgcolor=#FAFAD2>([1-9]\d{3,4})　([^<]+?)<\/td><td bgcolor=#FAFAD2>([A-Z]{2}\w{10})<\/td>/g,
      )) {
        map[code] ??= name.trim();
        // ISIN strMode=4 是「上櫃」清單，整批 mark 為 OTC
        otcCodes.add(code);
      }
    } catch {
      // big5 decode 失敗（罕見）— listed map 仍含 TWSE 部分
    }
  }

  // 2026-06-09：本地 stock-master.json 補全（離線保底）。
  // 上櫃名稱原本只靠 TPEx OpenAPI / ISIN，但 TPEx 對「Node spawn 的 curl」會 bot 擋
  // （見 curlFetch.ts 的 0514 註解）— prod server 首次建 map 那刻一被擋，就整片上櫃沒中文名
  // 並快取 24h（2026-06-09 實際踩到：3357 等 ~890 檔上櫃全顯示代號）。改用 youtube cron 維護的
  // 本地 23K code↔name（含 1009 檔 TPEx，純讀檔免網路）補網路沒蓋到的，並把 TPEx-market 代號
  // 補進 otcCodes，讓 isOTC 路由不再受 TPEx 抓取成敗影響。網路有抓到的名稱優先（此處只 fill gap）。
  const smEntries = loadStockMasterEntries();
  if (smEntries) {
    let nameFilled = 0;
    let otcFilled = 0;
    for (const e of smEntries) {
      if (!e.code || !e.name) continue;
      if (map[e.code] == null) { map[e.code] = e.name; nameFilled++; }
      if (e.market === 'TPEx' && !otcCodes.has(e.code)) { otcCodes.add(e.code); otcFilled++; }
    }
    if (nameFilled || otcFilled) {
      console.info(`[TWSENames] stock-master 補全 — names+${nameFilled} otc+${otcFilled}`);
    }
  } else {
    console.warn('[TWSENames] stock-master 補全略過: 本地檔不存在或無 entries');
  }

  console.info(`[TWSENames] buildNameMap done — TWSE=${twseAdded} TPEx=${tpexAdded} ISIN${isinUsed ? '=used' : '=skip'} total=${Object.keys(map).length} otc=${otcCodes.size}`);
  return { map, otcCodes };
}

/**
 * 查詢台灣股票中文名稱。
 * @param code  純數字代號（不帶 .TW/.TWO），例如 "2330"
 * @returns     中文公司名，若查無則回傳 null
 */
// Inflight singleflight：多個並行 caller 共享同一個 buildNameMap promise，
// 避免每次都重新打 TWSE/TPEx openapi（5/11 dev 端實測：page 載入瞬間並行 7+ 次
// getTWChineseName 各觸發自己的 buildNameMap → 上游 timeout 互相干擾）
let buildInflight: Promise<BuildResult> | null = null;

/** 共用 inflight builder — 拿 map 與 otcCodes 同時 cache */
async function ensureBuilt(): Promise<BuildResult> {
  const cachedMap = globalCache.get<NameMap>(NAMES_CACHE_KEY);
  const cachedOtc = globalCache.get<Set<string>>(OTC_SET_CACHE_KEY);
  if (cachedMap && cachedOtc) {
    return { map: cachedMap, otcCodes: cachedOtc };
  }
  if (!buildInflight) {
    buildInflight = buildNameMap()
      .then((built) => {
        if (Object.keys(built.map).length > 0) {
          globalCache.set(NAMES_CACHE_KEY, built.map, NAMES_TTL);
          globalCache.set(OTC_SET_CACHE_KEY, built.otcCodes, NAMES_TTL);
        }
        return built;
      })
      .finally(() => {
        buildInflight = null;
      });
  }
  return buildInflight;
}

export async function getTWChineseName(code: string): Promise<string | null> {
  try {
    // cache 已建好 → 直接查（網路建構的名稱最新，且已含 stock-master gap-fill）
    const cachedMap = globalCache.get<NameMap>(NAMES_CACHE_KEY);
    if (cachedMap) return cachedMap[code] ?? null;
    // 2026-06-11 冷啟動 fast path：buildNameMap 打 TWSE/TPEx/ISIN 最長 30s，但熱路徑
    // 名稱預算只有 3s（nameWithTimeout）→ 重啟後第一批走圖左上角只剩代號沒中文名。
    // 先踢背景 build，立刻用本地 stock-master.json 回名字；本地也查無才等完整 build。
    const inflight = ensureBuilt();
    inflight.catch(() => {}); // fast path 提前 return 時避免 unhandled rejection
    const local = getLocalNameMap();
    if (local?.[code]) return local[code];
    const { map } = await inflight;
    return map[code] ?? null;
  } catch {
    return null;
  }
}

/**
 * 判斷台股代號是否為「上櫃股」(TPEx OTC)，用於 isOTC 偵測（2026-05-21 加）
 *
 * 原本 TWSEHistProvider.isOTC 用「.TWO suffix 或 code 長度 5 位」啟發式，
 * 但 3236 千如 等 4 位數的上櫃股就被誤判為 TSE，TWSE endpoint 沒資料→ fallback 到
 * Yahoo 取得 adjusted close（除息後減 1 元）→ 昨收偏離真實 raw close，漲跌幅算錯。
 *
 * 改用 TWSENames 從 TPEx openapi / ISIN strMode=4 抓的權威 OTC 列表。
 *
 * @param code  純數字代號（不帶 .TW/.TWO），例如 '3236'
 * @returns     true=上櫃；false=非上櫃（上市/找不到）；資料還沒 build 完時 throw（caller 自行決定 fallback）
 */
export async function isOTCStock(code: string): Promise<boolean> {
  const { otcCodes } = await ensureBuilt();
  return otcCodes.has(code);
}

/**
 * 同步檢查 OTC（cache 有時用，cache 沒時回 undefined 讓 caller fallback）
 * 對於關鍵路徑用 isOTCStock() async 版；單機 hot-path 或啟動初期可用 sync 版避免 await chain
 */
export function isOTCStockSync(code: string): boolean | undefined {
  const otc = globalCache.get<Set<string>>(OTC_SET_CACHE_KEY);
  if (!otc) return undefined;
  return otc.has(code);
}
