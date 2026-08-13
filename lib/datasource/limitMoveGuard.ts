/**
 * Limit-up close-overwrite guard
 *
 * 漲跌停股的最終收盤在收盤集合競價，realtime/L2 snapshot 可能拍到盤中
 * 最後一筆 tick（已從漲停回落或從跌停反彈），寫入會污染 L1 close。
 *
 * 偵測模式：今日 high 觸及前日收盤 ±漲跌停幅度，但 close 偏離 high/low > 3%。
 *
 * 漲跌停幅度：
 *   - TW 上市/上櫃：±10%（含主板與興櫃）
 *   - CN 創業板（300/301）/ 科創板（688）：±20%
 *   - CN 主板（00x/60x）：±10%
 *
 * 用法：
 *   if (suspectsLimitOverwrite(prevClose, q, market, code)) skip;
 */

import { getLimitMovePct } from '@/lib/utils/limitRules';
import { isTwEtf, isValidTwTick } from './twTick';

export interface QuoteOHLC {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Market = 'TW' | 'CN';

export function limitPctFor(market: Market, code: string): number {
  // DF2 修正：板別判定走單一事實 getLimitMovePct（lib/utils/limitRules.ts），
  // 含全 30xxxx 創業板 + 68[89] 科創（原本 /^30[01]/ + /^688/ 漏了 689 科創與 302-309 創業板）。
  // 0.198 / 0.098 是偵測用 margin（略小於名目 ±20% / ±10%），刻意保留。
  return getLimitMovePct(market, code) >= 0.2 ? 0.198 : 0.098;
}

/**
 * 回傳 true 表示「snapshot 的 close 看起來不是真正的集合競價收盤」，呼叫端應 skip。
 *
 * 條件全部成立才回傳 true：
 *   1) prevClose 有效（>0）
 *   2) high 觸及漲停 OR low 觸及跌停
 *   3) close 與漲跌停 high/low 偏離 > 3%
 */
export function suspectsLimitOverwrite(
  prevClose: number | null | undefined,
  q: QuoteOHLC,
  market: Market,
  code: string,
): boolean {
  if (!prevClose || prevClose <= 0) return false;
  const limitPct = limitPctFor(market, code);
  const hitLimitUp = q.high >= prevClose * (1 + limitPct) * 0.999;
  const hitLimitDown = q.low <= prevClose * (1 - limitPct) * 1.001;
  return (hitLimitUp && q.close < q.high * 0.97)
      || (hitLimitDown && q.close > q.low * 1.03);
}

/**
 * 粗粒度防呆：單日 close 偏離前收 > 50% = 不可能的真實單日變動（漲跌停最多 ±20%，
 * 即使疊加除權息也到不了 50%）。多半是「同碼撞庫」（例：000001.SS 上證指數值寫進
 * 000001.SZ 平安銀行）、壞抓、或單位錯。L2 注入命中時應 skip、改走權威 API（API 走
 * suffix-aware provider，不會撞庫；停牌復牌型大跳空也由 API 拿到正確值）。
 */
export function suspectsGrossJump(prevClose: number | null | undefined, q: QuoteOHLC): boolean {
  if (!prevClose || prevClose <= 0 || !(q.close > 0)) return false;
  return Math.abs(q.close / prevClose - 1) > 0.5;
}

/**
 * 興櫃轉上市／上櫃首日的制度切換辨識。
 *
 * 興櫃成交可出現 81.73 這類非集中市場檔位，轉上市首日則回到標準 tick；承銷價也可能
 * 與前一日興櫃價差超過 50%，且成交量從數十張跳到上萬張。這不是撞庫錯價，官方日線
 * 必須放行。三個條件同時成立，避免只靠「大跌＋爆量」誤放一般污染。
 */
export function isTwListingTransition(
  symbol: string,
  previous: (QuoteOHLC & { volume?: number }) | null | undefined,
  official: QuoteOHLC & { volume?: number },
): boolean {
  if (!previous || !(previous.close > 0) || !(official.close > 0)) return false;
  // 興櫃轉集中市場的承銷價差不一定超過一般 gross-jump 的嚴格 50% 門檻；
  // 7855 實際為 82 → 43.75（-46.6%）。其餘 off-grid + 成交量制度切換條件仍需同時成立。
  const priceRegimeChanged = Math.abs(official.close / previous.close - 1) >= 0.4;
  const etf = isTwEtf(symbol);
  const fields: Array<keyof QuoteOHLC> = ['open', 'high', 'low', 'close'];
  const previousHasOffGridPrice = fields.some(k => !isValidTwTick(previous[k], etf));
  const officialAllOnGrid = fields.every(k => isValidTwTick(official[k], etf));
  const previousVolume = previous.volume ?? 0;
  const officialVolume = official.volume ?? 0;
  const volumeRegimeChanged = previousVolume >= 0
    && officialVolume >= 1_000
    && officialVolume >= Math.max(1, previousVolume) * 30;
  return priceRegimeChanged && previousHasOffGridPrice && officialAllOnGrid && volumeRegimeChanged;
}
