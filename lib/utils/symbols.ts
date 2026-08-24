/**
 * 代號工具 — 單一事實來源。
 *
 * isIndexSymbol：判斷一個代號是否為「大盤指數」而非個股。
 * 指數沒有籌碼 / 基本面 / 估值 / 軋空 / 成本等個股資料，per-symbol 的 API route 與
 * 側欄面板都應先用這個 helper 短路掉指數，避免：
 *   - 對指數打外部資料源 → 卡住 / 逾時（fake-IP DNS 下尤其嚴重）
 *   - 回傳全 0 的假分析被前端當真畫出來（誤導）
 *   - 面板永遠卡載入骨架
 *
 * 過去散落 7+ 份各自為政的 ad-hoc 判斷（有的只看 '^'、有的硬寫 000300.SS / 399001），
 * 用這支統一，涵蓋台股/美股指數（^TWII/^TWOII/^IXIC…）與陸股指數。
 *
 * ⚠ 陸股指數「後綴是權威」：000001.SS = 上證指數（指數），但 000001.SZ = 平安銀行（個股）；
 *   399001.SZ = 深證成指（指數）。所以必須比對「完整代號（含正確後綴）」，不可只看數字段，
 *   否則會把平安銀行誤判成指數、擋掉它的籌碼/成本/軋空資料。
 */

// 陸股指數的權威完整代號（後綴固定）— 與 IntradayCache / CandleStorageAdapter / cn-sanse 一致
const CN_INDEX_SYMBOLS = new Set<string>([
  '000001.SS', // 上證指數
  '000300.SS', // 滬深 300
  '399001.SZ', // 深證成指
  '399006.SZ', // 創業板指
]);

export function isIndexSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  // 臺股期貨近月連續線：和大盤指數一樣沒有個股籌碼／基本面資料。
  if (symbol.toUpperCase() === 'TXF') return true;
  // 台股 / 美股指數：^ 前綴（^TWII、^TWOII、^IXIC…）
  if (symbol.startsWith('^')) return true;
  // 陸股指數：完整代號 + 正確後綴（大小寫不敏感）
  return CN_INDEX_SYMBOLS.has(symbol.toUpperCase());
}

// ── 海外（美 / 日 / 韓）ticker 偵測（2026-06-12 加，海外同業對照 peerMap 用）────
//
// Yahoo Finance 對東京證交所用 `.T` 後綴（如 285A.T Kioxia）、首爾用 `.KS` 後綴
// （如 005930.KS Samsung）。YahooDataProvider 的日K抓取（v8 chart URL）對任意
// symbol 透傳，且其 .TW/.TWO 量單位轉換 regex 與台/陸即時覆蓋的 extractor 都
// 不會誤吃 .T/.KS — 所以日韓股可直接走既有 provider；這裡提供後綴判斷的
// 單一事實給儲存層 / cron / 測試使用。
//
// ⚠ 不可影響既有判斷：台股（.TW/.TWO）、陸股（.SS/.SZ）、場外基金（.OF）
//   一律回 false；指數（^ 前綴）另用 isIndexSymbol。

/** 美股 ticker：1-5 字母（可帶 -B 類股別後綴）、無交易所後綴。與 YahooDataProvider.extractUSTicker 同規則 */
export function isUSTicker(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  if (/^\d/.test(symbol)) return false;
  return /^[A-Z]{1,5}(-[A-Z])?$/i.test(symbol);
}

/** 東京證交所 ticker：4 碼證券代碼（首碼數字、可含字母，如 6981.T / 285A.T）+ .T 後綴 */
export function isTokyoTicker(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return /^\d[0-9A-Z]{3}\.T$/i.test(symbol);
}

/** 韓國交易所（KOSPI）ticker：6 碼數字 + .KS 後綴（如 005930.KS / 000660.KS） */
export function isSeoulTicker(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return /^\d{6}\.KS$/i.test(symbol);
}

/** 海外個股（美 / 日 / 韓）。台股 / 陸股 / 基金後綴一律 false；指數（^）不算（另用 isIndexSymbol） */
export function isOverseasTicker(symbol: string | null | undefined): boolean {
  return isUSTicker(symbol) || isTokyoTicker(symbol) || isSeoulTicker(symbol);
}
