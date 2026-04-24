/**
 * L1CandleCache — L1 日K 資料記憶體快取（本地開發專用）
 *
 * 問題背景：
 *   每次 scanSOP / scanBuyMethod 需逐檔讀取 JSON（CN 3062 檔 / TW 1959 檔），
 *   全在磁碟 I/O，單次掃描需 40–50 秒（macOS SSD 仍有 syscall 開銷）。
 *
 * 解法：
 *   第一次讀取某市場 JSON 後，把 CandleFileData 存入 Map；
 *   同時觸發背景 bulk preload，把整個市場目錄批次讀進記憶體。
 *   之後同市場的讀取直接命中 Map，從磁碟讀降為 O(1) 查表。
 *
 * 記憶體估算：
 *   CN 3062 檔 × ~50KB parsed = ~153MB
 *   TW 1959 檔 × ~50KB parsed = ~100MB
 *   合計 ~250MB（本地開發機可接受）
 *
 * Vercel 上不啟用（IS_VERCEL = true）：Blob 讀取是網路操作，快取反而複雜化。
 *
 * 失效策略：
 *   writeCandleFile 寫入後呼叫 updateCache() 更新對應 entry。
 *   不需要定時重置，因為 L1 只有 cron 才寫入，且寫入後立即更新快取。
 */

import type { CandleFileData } from './CandleStorageAdapter';

const IS_VERCEL = !!process.env.VERCEL;

// ── 內部狀態 ────────────────────────────────────────────────────────────────────

/** key = `${market}/${symbol}`，value = raw CandleFileData（不含指標） */
const _store = new Map<string, CandleFileData>();

/** 已完成 bulk load 的市場 */
const _marketLoaded = new Set<'TW' | 'CN'>();

/** 正在執行 bulk load 的 Promise（去重用） */
const _marketLoading = new Map<'TW' | 'CN', Promise<void>>();

// ── 公開 API ────────────────────────────────────────────────────────────────────

/**
 * 取快取資料。未命中回傳 null（呼叫方負責從磁碟讀，再呼叫 updateCache）。
 */
export function getFromCache(symbol: string, market: 'TW' | 'CN'): CandleFileData | null {
  if (IS_VERCEL) return null;
  return _store.get(`${market}/${symbol}`) ?? null;
}

/**
 * 寫入或更新快取 entry（writeCandleFile 寫入後呼叫）。
 */
export function updateCache(symbol: string, market: 'TW' | 'CN', data: CandleFileData): void {
  if (IS_VERCEL) return;
  _store.set(`${market}/${symbol}`, data);
}

/**
 * 刪除特定 entry（若需強制讓下次讀取重新從磁碟取）。
 */
export function invalidateEntry(symbol: string, market: 'TW' | 'CN'): void {
  if (IS_VERCEL) return;
  _store.delete(`${market}/${symbol}`);
}

/**
 * 觸發背景 bulk preload（fire-and-forget，冪等）。
 * readCandleFile cache miss 時自動呼叫；也可在掃描前顯式呼叫。
 */
export function triggerPreload(market: 'TW' | 'CN'): void {
  if (IS_VERCEL) return;
  if (_marketLoaded.has(market) || _marketLoading.has(market)) return;
  _doPreload(market).catch(err =>
    console.error(`[L1Cache] ${market} background preload 失敗:`, err)
  );
}

/**
 * 等候 bulk preload 完成（scan route 在掃描前顯式呼叫可讓首掃更快）。
 * 若已完成則立即回傳。
 */
export async function ensureMarketLoaded(market: 'TW' | 'CN'): Promise<void> {
  if (IS_VERCEL) return;
  if (_marketLoaded.has(market)) return;
  await _doPreload(market);
}

/** 統計資訊（診斷用） */
export function getCacheStats(): { entries: number; markets: string[] } {
  return {
    entries: _store.size,
    markets: [..._marketLoaded],
  };
}

// ── 內部實作 ────────────────────────────────────────────────────────────────────

function _doPreload(market: 'TW' | 'CN'): Promise<void> {
  // 已在跑，等同一個 Promise
  const existing = _marketLoading.get(market);
  if (existing) return existing;

  const p = _loadAllFiles(market);
  _marketLoading.set(market, p);
  p.finally(() => _marketLoading.delete(market));
  return p;
}

async function _loadAllFiles(market: 'TW' | 'CN'): Promise<void> {
  const { readdir, readFile } = await import('fs/promises');
  const { join } = await import('path');

  const dir = join(process.cwd(), 'data', 'candles', market);
  const t0 = Date.now();

  let jsonFiles: string[];
  try {
    const entries = await readdir(dir);
    jsonFiles = entries.filter(f => f.endsWith('.json'));
  } catch (err) {
    console.error(`[L1Cache] ${market} 讀目錄失敗:`, err);
    _marketLoaded.add(market); // 標記完成，避免無限重試
    return;
  }

  console.info(`[L1Cache] ${market} bulk preload 開始，共 ${jsonFiles.length} 檔...`);

  const BATCH = 30; // 每批並行 30 個 readFile，避免佔滿 event loop 導致其他 request timeout
  let loaded = 0;
  let failed = 0;

  for (let i = 0; i < jsonFiles.length; i += BATCH) {
    const batch = jsonFiles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (file) => {
        try {
          const raw = await readFile(join(dir, file), 'utf-8');
          const data: CandleFileData = JSON.parse(raw);
          if (!data.candles || data.candles.length === 0) return;

          // 清除 TWSE 除權息日標記（`*`）
          for (const c of data.candles) {
            if (c.date.endsWith('*')) c.date = c.date.slice(0, -1);
          }
          if (data.lastDate.endsWith('*')) data.lastDate = data.lastDate.slice(0, -1);

          const symbol = file.replace(/\.json$/, '');
          _store.set(`${market}/${symbol}`, data);
          loaded++;
        } catch {
          failed++;
        }
      })
    );
    // 讓出 event loop，避免連續大批 I/O 讓其他 request（Fugle 等）timeout
    await new Promise(r => setTimeout(r, 0));
  }

  _marketLoaded.add(market);
  const elapsed = Date.now() - t0;
  console.info(
    `[L1Cache] ${market} bulk preload 完成：${loaded} 成功 / ${failed} 失敗 / ${elapsed}ms`
  );
}
