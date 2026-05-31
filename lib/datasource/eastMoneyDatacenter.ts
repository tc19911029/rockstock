/**
 * EastMoney datacenter 共用 fetch helper — 集中處理快取 / 重試 / 限流防護。
 *
 * 背景：EastMoney 偶爾回 HTML（限流/維護）或 502。裸 res.json() 會丟 SyntaxError；
 * 連續打多檔（個股面板重渲染 / 掃描迴圈）會觸發限流。此 helper：
 *   1. globalCache（對標 EastMoneyFundamentals 的 30 分鐘 cache）→ 同 key 不重打
 *   2. 重試 1 次（網路錯/非 200 先重試）
 *   3. 用 res.text() + try JSON.parse → HTML/限流時優雅回 []（不丟例外）
 */

import { globalCache } from './MemoryCache';

const BASE = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

export interface DatacenterOpts {
  reportName: string;
  columns: string;          // 逗號分隔欄位（不編碼）
  filterField: string;      // 過濾欄名，如 SECURITY_CODE / SCODE
  code: string;             // 6 位代碼
  sortColumns: string;      // 排序欄
  sortTypes?: -1 | 1;       // 預設 -1（新→舊）
  pageSize?: number;        // 預設 20
  cacheKey: string;         // 快取鍵
  ttlMs?: number;           // 快取存活，預設 30 分鐘
}

/** 抓 EastMoney datacenter 一頁資料；失敗/限流/空 一律回 []（永不丟例外）。 */
export async function fetchEmDatacenter(o: DatacenterOpts): Promise<Record<string, unknown>[]> {
  const cached = globalCache.get<Record<string, unknown>[]>(o.cacheKey);
  if (cached) return cached;

  const url = `${BASE}?reportName=${o.reportName}&columns=${o.columns}` +
    `&filter=(${o.filterField}=%22${encodeURIComponent(o.code)}%22)` +
    `&pageSize=${o.pageSize ?? 20}&pageNumber=1&sortColumns=${o.sortColumns}&sortTypes=${o.sortTypes ?? -1}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://data.eastmoney.com/' },
      });
      if (!res.ok) { if (attempt === 0) continue; return []; }
      const text = await res.text();
      let json: { success?: boolean; result?: { data?: Record<string, unknown>[] } | null };
      try { json = JSON.parse(text); } catch { return []; } // HTML/限流 → 優雅空
      const rows = json?.result?.data;
      const out = json?.success && Array.isArray(rows) ? rows : [];
      if (out.length) globalCache.set(o.cacheKey, out, o.ttlMs ?? 30 * 60 * 1000);
      return out;
    } catch {
      if (attempt === 0) continue; // 網路錯/timeout 重試 1 次
      return [];
    }
  }
  return [];
}
