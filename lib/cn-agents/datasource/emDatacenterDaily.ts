/**
 * EastMoney datacenter-web 通用日報表 provider — 自動翻頁 helper
 *
 * 對象：https://datacenter-web.eastmoney.com/api/data/v1/get（公開唯讀 GET）。
 * 龍虎榜全榜 / 席位明細 / 後續其他 datacenter 報表都走這個入口，只差 reportName
 * 與 filter — 收斂成單一翻頁函式，節流與「無資料日」語意一次寫對。
 *
 * 實測（2026-06-13 00:15 CST，對 TRADE_DATE='2026-06-12'）：
 *   - 回應形狀 { version, result: { pages, data: [...] }, success, message, code }
 *   - 無資料日（週末/假日）回 { result: null, success: false, message: '返回数据为空',
 *     code: 9201 } — 這「不是錯誤」，回 [] 讓呼叫端自然跳過
 *   - filter 語法：多條件直接串接，如 (TRADE_DATE='2026-06-12')(SECURITY_CODE="000032")
 *
 * 陷阱：
 *   1. datacenter-web host 與被批量封鎖的 push2his 不同網段，輕量呼叫安全，
 *      但仍要頁間 300ms 節流（與 emLimitUpPool 的 push2ex 同精神）
 *   2. pages 以「第一頁回應」為準 — 翻頁中 server 端資料變動（盤後回補）可能
 *      讓尾頁短少，maxPages 防護無限翻頁
 *   3. 失敗鏈走 fetchJsonWithCurlFallback（node fetch → curl → 本機代理），
 *      與全 repo 對外抓取慣例一致
 */

import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';

const DC_ENDPOINT = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
/** 頁間節流（datacenter 輕量但不可突發連打） */
const PAGE_THROTTLE_MS = 300;
const DEFAULT_PAGE_SIZE = 500;
/** 防 pages 異常大造成無限翻頁（500 × 20 = 一萬筆，遠超單日任何報表） */
const DEFAULT_MAX_PAGES = 20;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** EM datacenter 標準回應殼（data 為任意報表 row，由呼叫端 mapper 收斂型別） */
interface EmDatacenterResponse {
  version?: string | null;
  result?: { pages?: number; count?: number; data?: Record<string, unknown>[] | null } | null;
  success?: boolean;
  message?: string;
  code?: number;
}

export interface EmDatacenterDailyOpts {
  /** 報表名，如 'RPT_DAILYBILLBOARD_DETAILSNEW' */
  reportName: string;
  /** 預設 'ALL' */
  columns?: string;
  /** 原樣 filter 字串（本函式負責 URL encode），如 (TRADE_DATE='2026-06-12') */
  filter: string;
  sortColumns: string;
  /** '1' 升冪 / '-1' 降冪；預設 '1' */
  sortTypes?: string;
  pageSize?: number;
  maxPages?: number;
}

/**
 * 抓 datacenter 報表全部分頁 rows。
 *
 * - 自動翻頁到 result.pages（受 maxPages 上限保護），頁間 300ms 節流
 * - result 為 null 或 result.data 為 null（無資料日 / 篩選無命中）→ 回 []
 * - 網路層失敗（fetch 與 curl 都掛）→ throw（由呼叫端決定備援或記 _health）
 */
export async function fetchEmDatacenterDaily(opts: EmDatacenterDailyOpts): Promise<Record<string, unknown>[]> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const rows: Record<string, unknown>[] = [];
  let totalPages = 1;

  for (let page = 1; page <= Math.min(totalPages, maxPages); page++) {
    if (page > 1) await sleep(PAGE_THROTTLE_MS);
    const url = `${DC_ENDPOINT}?reportName=${encodeURIComponent(opts.reportName)}`
      + `&columns=${encodeURIComponent(opts.columns ?? 'ALL')}`
      + `&filter=${encodeURIComponent(opts.filter)}`
      + `&pageNumber=${page}&pageSize=${pageSize}`
      + `&sortColumns=${encodeURIComponent(opts.sortColumns)}`
      + `&sortTypes=${encodeURIComponent(opts.sortTypes ?? '1')}`
      + `&source=WEB&client=WEB`;
    const { data: resp } = await fetchJsonWithCurlFallback<EmDatacenterResponse>(url, { timeoutMs: 20_000 });

    // 無資料日（code=9201「返回数据为空」）或篩選無命中 — 不是錯誤，回 []
    if (!resp?.result || !Array.isArray(resp.result.data)) {
      if (page === 1) return [];
      break; // 翻頁中途資料消失（server 端回補競態）— 回已收集的部分
    }

    if (page === 1) {
      const pages = resp.result.pages;
      totalPages = typeof pages === 'number' && Number.isFinite(pages) && pages > 0 ? pages : 1;
    }
    if (resp.result.data.length === 0) break;
    rows.push(...resp.result.data);
  }
  return rows;
}
