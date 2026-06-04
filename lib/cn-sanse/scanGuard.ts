// ============================================================
// 三色資金 — 盤後掃描「退化結果」偵測（TW/CN 共用，純函式無 I/O）。
//
// 背景（2026-06-04 台股實例）：盤後早班 cron 16:00 觸發時，個股日K已封到今日（14:15 eod-settle），
// 但加權指數 ^TWII 的今日那根要到 ~16:39 才寫入。scanSanSe/scanTwSanSe 用「指數最後一根」當 lastDate
// （行情日曆基準），於是 lastDate 還停在前一交易日，1942 檔已在今日的個股全被新鮮度檢查
// （最後一根 !== lastDate）判成 stale 砍光，只剩極少數剛好還在前一日的檔被評到。
// 結果：lastDate 錯標成前一日 → 近乎空的結果被寫進前一日的檔，把那天本來好的盤後紀錄覆蓋掉。
//
// 此函式讓 route 在存檔前先擋下這種「stale 主導」的退化掃描：不存檔、回報原因，交給較晚那一輪
// （資料齊全後）重產正確紀錄。對正常盤後（stale 只有停牌/下市少數檔，占比 < 1%）完全無感；
// 對指定 ?date= 的歷史回補也安全（指數有該日 → 個股對齊 → stale 占比低，不會誤擋）。
// ============================================================
import type { SanSeScanResult } from './scan';

/** stale 占「實際納入考慮個股」過半即視為退化。正常 < 1%；指數落後競態會衝到 ~99%，門檻有極大餘裕。 */
export const STALE_DEGENERATE_FRACTION = 0.5;

/**
 * 判斷盤後掃描結果是否退化（多半是指數 L1 封存落後個股，或全市場資料缺口）。
 * @returns 退化原因字串（route 用來回報並跳過存檔）；正常則回 null。
 */
export function degenerateScanReason(result: SanSeScanResult): string | null {
  // freshCount = 最後一根 === lastDate 的檔數（通過新鮮度檢查、進入成交額排名前的母數）
  const freshCount = result.evaluated + (result.turnoverFiltered ?? 0);
  const considered = freshCount + result.staleSkipped;
  if (considered === 0) return 'empty universe (no candles loaded)';
  const staleFrac = result.staleSkipped / considered;
  if (staleFrac > STALE_DEGENERATE_FRACTION) {
    return `stale-dominated ${(staleFrac * 100).toFixed(1)}% — 指數封存恐落後個股，跳過存檔以免覆蓋既有紀錄`;
  }
  return null;
}
