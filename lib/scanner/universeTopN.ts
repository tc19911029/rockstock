/**
 * 成交額 universe 深度 — 單一事實。
 *
 * 為何獨立成純常數模組（不 import 任何東西）：多個合約測試把
 * `@/lib/scanner/TurnoverRank` 整檔 jest.mock 掉，常數若住在那裡會一起被清空；
 * TurnoverRank / cn-sanse / tw-sanse / ScanPipeline / scanStorage 都從這裡讀。
 */

/**
 * 書本買法掃描池深度：成交額前 500（回測冠軍組合 top500 + MTF≥3），TW/CN 一致。
 *
 * 索引檔可以比它深（CN=800 供三色用）— 書本鏈路一律以「名次 ≤ BOOK_UNIVERSE_TOP_N」
 * 截取，不可用「索引成員身分」當池子，否則索引擴深會靜默撐大書本池。
 */
export const BOOK_UNIVERSE_TOP_N = 500;

/**
 * data/turnover-rank/{market}.json 索引收錄深度 = 全部消費者需求的最大值：
 *   TW：書本 500 = 三色 500 → 500
 *   CN：三色 800 > 書本 500 → 800
 * 三色池深 SANSE_TURNOVER_TOP_N（lib/cn-sanse/scan.ts）直接引用此常數。
 */
export const TURNOVER_INDEX_TOP_N: Record<'TW' | 'CN', number> = { TW: 500, CN: 800 };
