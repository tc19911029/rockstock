/**
 * 績效漲幅固定天數（單一事實）
 *
 * 看績效一律看「過去 N 日漲幅」= 1,2,3,4,5,6,7,8,9,10,20 日。
 * rets 陣列一律照這個順序對齊（sectorRanking / hotThemeScan / /sectors UI 共用）。
 *
 * ⚠️ 這個檔必須維持「純常數、零 import」— 會被 client component（app/sectors/page.tsx）import，
 * 不可拉進任何 server-only（fs / candle）相依。trailing 漲幅的計算放在各 server 模組內。
 */
export const PERF_PERIODS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20] as const;

/** 法人金額 / 融資張數的天數視窗。與 PERF_PERIODS 的卡片顯示窗 [1,2,3,4,5,10,20] 對齊，
 *  讓「漲幅／法人／融資」三排同欄。索引一律用 INST_PERIODS.indexOf(n) 動態取，不可寫死。 */
export const INST_PERIODS = [1, 2, 3, 4, 5, 10, 20] as const;
