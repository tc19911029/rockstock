// lib/datasource/MemoryCache.ts

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * 簡單的記憶體快取，避免重複請求相同資料。
 * TTL 預設 5 分鐘（即時模式）或 24 小時（歷史資料）。
 */
export class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();

  /**
   * 取得快取資料，若不存在或已過期則回傳 null
   */
  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  /**
   * 設定快取資料
   * @param ttlMs TTL（毫秒），預設 5 分鐘
   */
  set<T>(key: string, data: T, ttlMs = 5 * 60 * 1000): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  /** 清除所有快取 */
  clear(): void {
    this.store.clear();
  }

  /** 回傳快取中的 key 數量 */
  get size(): number {
    return this.store.size;
  }
}

/** 全域單例快取（server-side，每次 server restart 重置） */
export const globalCache = new MemoryCache();
