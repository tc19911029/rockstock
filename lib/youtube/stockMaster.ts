/**
 * TW Stock master — 代號/名稱對照 + alias map + 模糊匹配。
 *
 * 設計：
 *   - 從 TWSE / TPEx OpenAPI 抓全市場 code+name（如失敗用 FALLBACK）
 *   - 寫到 data/youtube/stock-master.json，7 天 TTL
 *   - 內建 ALIAS_MAP 處理理財節目常見簡稱（世芯=3661, 創意=3443 等）
 *   - lookup(query) 回 { code, name, confidence }，confidence ∈ [0, 1]
 *
 * MVP 3 目標：解決 LLM 提取出的「股票名稱字串」→ TW 股票代號 的對照。
 * 不解決：CN/HK/US 股、未上市公司、ETF（ETF 還是用名稱對照即可，無 KY 之類後綴問題）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';

const FS_PATH = path.join(process.cwd(), 'data', 'youtube', 'stock-master.json');
const BLOB_KEY = 'youtube/stock-master.json';
const TTL_MS = 7 * 24 * 3600_000;
const IS_VERCEL = !!process.env.VERCEL;

export interface StockMasterEntry {
  code: string;             // '2330'（去掉 .TW 後綴）
  name: string;             // '台積電' 或 '世芯-KY' 等正式名
  market: 'TWSE' | 'TPEx';
  aliases: string[];        // 常見簡稱
}

export interface StockMasterFile {
  fetched_at: string;       // ISO
  entries: StockMasterEntry[];
}

/**
 * 理財節目常見簡稱對照（手動維護）。
 * 多數情況 LLM 已能輸出完整名稱，這個 map 用來補課 LLM 輸出的純簡稱。
 *
 * 規則：key = LLM 可能輸出的簡稱，value.code = 對應股票代號
 * 之後再透過 code 查 master entries 拿正式名稱。
 */
const ALIAS_MAP: Record<string, string> = {
  // 半導體大盤股
  '台積電': '2330', '台積': '2330', 'TSMC': '2330',
  '聯發科': '2454', '聯電': '2303',
  '世芯': '3661', 'eMemory': '3529',
  '創意': '3443',
  '智原': '3035',
  '愛普': '6531', '愛普*': '6531',
  // PCB / 載板
  '欣興': '3037', '金像電': '2368', '台光電': '2383',
  '南電': '8046',
  // 散熱
  '雙鴻': '3324', '奇鋐': '3017', '建準': '2421',
  // ASIC / AI 伺服器
  '緯穎': '6669', '緯創': '3231', '廣達': '2382', '英業達': '2356',
  '技嘉': '2376', '華碩': '2357', '宏碁': '2353',
  '鴻海': '2317',
  // 記憶體
  '南亞科': '2408', '華邦電': '2344', '威剛': '3260',
  // 大盤金融
  '中信金': '2891', '國泰金': '2882', '富邦金': '2881', '兆豐金': '2886',
  '玉山金': '2884', '元大金': '2885', '第一金': '2892',
  // CCL
  '聯茂': '6213', '台燿': '6274',
  // 元件
  '國巨': '2327', '國巨*': '2327',
  // 其他常被提到
  '長榮': '2603', '陽明': '2609', '萬海': '2615',
  '中華電': '2412', '台達電': '2308', '大立光': '3008',
  // master 短名 vs 常見全名 — 2026-05-24 加，避免分析寫全名後與 master 不一致
  '世界先進': '5347',          // master 只存「世界」
  '矽力-KY': '6415', '矽力': '6415',  // master 含 * 為「矽力*-KY」（除權息標記）
  // 2026-05-23 + 5/24 節目提到、之前 ALIAS_MAP 沒列的
  '同欣電': '6271', '台表科': '6278',
  '大量': '3167', '尖點': '8021', '鉅橡': '8074',
  '宜鼎': '5289', '群聯': '8299', '鈺創': '5351', '富采': '3714',
  '日月光投控': '3711', '貿聯-KY': '3665', '貿聯': '3665',
  '嘉澤': '3533', '安可': '3615',
};

// ── load / refresh master ────────────────────────────────────────────────────

let memoryCache: StockMasterFile | null = null;
let memoryCacheLoadedAt = 0;

export async function loadStockMaster(forceRefresh = false): Promise<StockMasterFile> {
  if (!forceRefresh && memoryCache && Date.now() - memoryCacheLoadedAt < 3600_000) {
    return memoryCache;
  }
  // 試讀檔案
  const existing = await loadFromDisk();
  if (existing && !forceRefresh) {
    const age = Date.now() - new Date(existing.fetched_at).getTime();
    if (age < TTL_MS) {
      memoryCache = existing;
      memoryCacheLoadedAt = Date.now();
      return existing;
    }
  }
  // refresh from upstream
  const refreshed = await fetchAndBuild();
  await saveToDisk(refreshed);
  memoryCache = refreshed;
  memoryCacheLoadedAt = Date.now();
  return refreshed;
}

async function loadFromDisk(): Promise<StockMasterFile | null> {
  if (IS_VERCEL) {
    try {
      const { get } = await import('@vercel/blob');
      const result = await get(BLOB_KEY, { access: 'private' });
      if (!result || !result.stream) return null;
      const reader = result.stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as StockMasterFile;
    } catch { return null; }
  }
  try {
    return JSON.parse(await fs.readFile(FS_PATH, 'utf-8')) as StockMasterFile;
  } catch { return null; }
}

async function saveToDisk(data: StockMasterFile): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  if (IS_VERCEL) {
    const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
    await blobPutWithRetry(BLOB_KEY, json, {
      access: 'private', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json',
    });
  } else {
    await fs.mkdir(path.dirname(FS_PATH), { recursive: true });
    await atomicFsPut(FS_PATH, json);
  }
}

// ── fetch from TWSE / TPEx ───────────────────────────────────────────────────

interface TwseRow { Code: string; Name: string }
interface TpexRow { SecuritiesCompanyCode: string; CompanyName: string }

async function fetchAndBuild(): Promise<StockMasterFile> {
  const entries: StockMasterEntry[] = [];

  // TWSE
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL', {
      headers: { Accept: 'application/json' },
    });
    if (r.ok) {
      const rows = (await r.json()) as TwseRow[];
      for (const row of rows) {
        if (!row.Code || !row.Name) continue;
        entries.push({
          code: row.Code, name: row.Name, market: 'TWSE', aliases: [],
        });
      }
    }
  } catch (err) {
    console.warn('[stockMaster] TWSE fetch failed:', err);
  }

  // TPEx
  try {
    const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes', {
      headers: { Accept: 'application/json' },
    });
    if (r.ok) {
      const rows = (await r.json()) as TpexRow[];
      for (const row of rows) {
        if (!row.SecuritiesCompanyCode || !row.CompanyName) continue;
        entries.push({
          code: row.SecuritiesCompanyCode, name: row.CompanyName, market: 'TPEx', aliases: [],
        });
      }
    }
  } catch (err) {
    console.warn('[stockMaster] TPEx fetch failed:', err);
  }

  // 補 alias（從 ALIAS_MAP 反向標記）
  const byCode = new Map(entries.map(e => [e.code, e]));
  for (const [alias, code] of Object.entries(ALIAS_MAP)) {
    const entry = byCode.get(code);
    if (entry && !entry.aliases.includes(alias) && entry.name !== alias) {
      entry.aliases.push(alias);
    }
  }

  return {
    fetched_at: new Date().toISOString(),
    entries,
  };
}

// ── lookup ───────────────────────────────────────────────────────────────────

export interface StockLookupResult {
  code: string;
  name: string;
  market: 'TWSE' | 'TPEx';
  /** 0..1，越高代表越確定。 */
  confidence: number;
  /** 解釋此次匹配的依據（debug 用）。 */
  match_via: 'exact_code' | 'exact_name' | 'alias' | 'fuzzy_substring' | 'unknown';
}

/**
 * 用 query 字串（可能是代號、可能是名稱、可能是簡稱）找股票。
 *
 * Confidence rubric：
 *   1.00 — query 為 4 位純數字 code 且在 master 中
 *   0.95 — query 完整等於 master entry 的 name
 *   0.90 — query 完整等於某個 alias
 *   0.80 — query 是 name 或 alias 的 strict prefix
 *   0.60 — query 是 name 的 substring（長度 ≥ 2）
 *   0.00 — 找不到
 *
 * 注意：低於 0.6 caller 應視為 unknown。
 */
export function lookupStock(query: string, master: StockMasterFile): StockLookupResult | null {
  if (!query) return null;
  const q = query.trim();
  if (!q) return null;

  // 1) 純數字 code
  if (/^\d{4,6}$/.test(q)) {
    const hit = master.entries.find(e => e.code === q);
    if (hit) {
      return { code: hit.code, name: hit.name, market: hit.market, confidence: 1.0, match_via: 'exact_code' };
    }
    return null;  // 數字但找不到 → 不要 fuzzy
  }

  // 2) alias 直接命中
  const aliasCode = ALIAS_MAP[q];
  if (aliasCode) {
    const hit = master.entries.find(e => e.code === aliasCode);
    if (hit) {
      return { code: hit.code, name: hit.name, market: hit.market, confidence: 0.9, match_via: 'alias' };
    }
    // alias map 知道但 master 沒有（理論上不會發生）→ 用 alias map 當權威
    return { code: aliasCode, name: q, market: 'TWSE', confidence: 0.7, match_via: 'alias' };
  }

  // 3) 完整名稱匹配
  for (const e of master.entries) {
    if (e.name === q) {
      return { code: e.code, name: e.name, market: e.market, confidence: 0.95, match_via: 'exact_name' };
    }
    if (e.aliases.includes(q)) {
      return { code: e.code, name: e.name, market: e.market, confidence: 0.9, match_via: 'alias' };
    }
  }

  // 4) prefix 匹配（如 "台積" → "台積電"）— 必須 query 至少 2 字
  if (q.length >= 2) {
    const prefixHits = master.entries.filter(e =>
      e.name.startsWith(q) || e.aliases.some(a => a.startsWith(q))
    );
    if (prefixHits.length === 1) {
      const e = prefixHits[0];
      return { code: e.code, name: e.name, market: e.market, confidence: 0.8, match_via: 'fuzzy_substring' };
    }
    // 多個 prefix 命中 → 取最短 name 那個（最可能是用戶意指的簡稱對象）
    if (prefixHits.length > 1) {
      prefixHits.sort((a, b) => a.name.length - b.name.length);
      const e = prefixHits[0];
      return { code: e.code, name: e.name, market: e.market, confidence: 0.65, match_via: 'fuzzy_substring' };
    }
  }

  // 5) substring 匹配（最寬鬆）
  if (q.length >= 2) {
    const subHits = master.entries.filter(e =>
      e.name.includes(q) || e.aliases.some(a => a.includes(q))
    );
    if (subHits.length === 1) {
      const e = subHits[0];
      return { code: e.code, name: e.name, market: e.market, confidence: 0.6, match_via: 'fuzzy_substring' };
    }
  }

  return null;
}

/** 提供測試：直接從 ALIAS_MAP 建一個小 master，不打 network */
export function buildTestMaster(extras: Array<Pick<StockMasterEntry, 'code' | 'name' | 'market'>> = []): StockMasterFile {
  const seen = new Set<string>();
  const entries: StockMasterEntry[] = [];
  for (const [alias, code] of Object.entries(ALIAS_MAP)) {
    if (seen.has(code)) continue;
    seen.add(code);
    entries.push({ code, name: alias, market: 'TWSE', aliases: [] });
  }
  for (const ex of extras) {
    if (!seen.has(ex.code)) {
      entries.push({ ...ex, aliases: [] });
      seen.add(ex.code);
    }
  }
  // 重新填 aliases
  const byCode = new Map(entries.map(e => [e.code, e]));
  for (const [alias, code] of Object.entries(ALIAS_MAP)) {
    const entry = byCode.get(code);
    if (entry && entry.name !== alias) entry.aliases.push(alias);
  }
  return { fetched_at: new Date().toISOString(), entries };
}
