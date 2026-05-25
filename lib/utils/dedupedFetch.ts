/**
 * dedupedFetch — 跨組件共用 in-flight promise + 短 TTL cache
 *
 * 多個 React 組件同 tick mount 各自 fetch 同一 URL → 浪費網路。
 * 用法：把 fetch(url) 換成 dedupedFetch(url)，相同 URL 在 cacheTtlMs（預設 3 秒）內共用同個 promise。
 *
 * 適用場景：頁面載入瞬間多組件同時抓 portfolio / alerts / pool 等共享資料。
 * 不適用：polling（每次都要新鮮）、user 互動觸發（過了 TTL 沒差）。
 *
 * options:
 *   cacheTtlMs — 預設 3000ms。設 0 = 只 dedupe in-flight、不 cache 已完成。
 *   bustCache  — true → 略過 cache 直接打。
 */

interface CacheEntry { promise: Promise<Response>; expiresAt: number }
const cache = new Map<string, CacheEntry>();

interface DedupOptions {
  cacheTtlMs?: number;
  bustCache?: boolean;
  init?: RequestInit;
}

export function dedupedFetch(url: string, opts: DedupOptions = {}): Promise<Response> {
  const { cacheTtlMs = 3000, bustCache = false, init } = opts;
  if (bustCache) cache.delete(url);
  const entry = cache.get(url);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.promise.then(r => r.clone());
  }
  const p = fetch(url, init);
  cache.set(url, { promise: p, expiresAt: Date.now() + cacheTtlMs });
  // 失敗就立刻清掉 cache、不卡 stale 失敗
  p.catch(() => cache.delete(url));
  return p.then(r => r.clone());
}

/** 手動清掉某個 URL 的 cache（user 動作後想立刻刷新時用）*/
export function bustDedupCache(url: string): void {
  cache.delete(url);
}
