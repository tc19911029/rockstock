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
  // 台股 / 美股指數：^ 前綴（^TWII、^TWOII、^IXIC…）
  if (symbol.startsWith('^')) return true;
  // 陸股指數：完整代號 + 正確後綴（大小寫不敏感）
  return CN_INDEX_SYMBOLS.has(symbol.toUpperCase());
}
