/**
 * 融資（多方）追繳／警戒壓力價
 *
 *   融資維持率 = 現價 / (融資成本 × 融資成數)
 *   警戒價(140%)   = 1.40 × ratio × cost  → 成數 0.6 → 0.84 × cost
 *   追繳價(130%)   = 1.30 × ratio × cost  → 成數 0.6 → 0.78 × cost
 *   解除追繳(166%) = 1.66 × ratio × cost  → 成數 0.6 → 0.996 × cost
 *
 * 名詞順序（台灣實務）：維持率跌破 130% → 券商發「追繳令」→ 限期補繳，
 * 補到維持率 166% 解除；逾期未補才「斷頭」（券商代為處分）。
 * 所以 130% 是追繳線、不是斷頭價 — 斷頭是追繳沒補的後果，沒有固定價位。
 *
 * ⚠️ 注意：與融券（空方）公式「結構不同」。
 *   空方嘎空價 = cost × (1 + 保證金成數0.9) / 1.3 ≈ 1.46 × cost（價漲觸發）
 *   多方追繳價 = cost × 成數0.6 × 1.3 = 0.78 × cost（價跌觸發）
 *
 * ⚠️ 維持率券商是看「整戶」，不是「個股」；此價僅為單股理論估算壓力區。
 */

/**
 * 上市融資成數 60%
 *
 * 金管會令（民國 103.11.10 生效）：「最高融資比率上市及上櫃有價證券為六成」
 * https://law.fsc.gov.tw/LawContent.aspx?id=GL001349
 */
export const MARGIN_RATIO_LISTED = 0.6;
/**
 * 上櫃融資成數 60%
 *
 * ⚠️ 2026-07-20 修正：原本寫 0.5（沿用 103 年以前的舊制），導致上櫃股（如 3081 聯亞）
 * 算出來的追繳價偏低。金管會 103.11.10 起上櫃已與上市同為六成。
 * 常數保留兩個名字（呼叫端語意清楚），值相同。
 */
export const MARGIN_RATIO_OTC = 0.6;
/** 追繳線：整戶維持率低於 130% 券商發追繳令 */
export const LIQUIDATION_MAINTENANCE = 1.3;
/** 警戒線 140%：還沒到追繳，但已在邊緣 */
export const MARGIN_CALL_MAINTENANCE = 1.4;
/** 解除追繳 166%：被追繳後要補到這個維持率才解除 */
export const MARGIN_RELEASE_MAINTENANCE = 1.66;

export function marginLiquidationPrice(
  cost: number | null,
  ratio = MARGIN_RATIO_LISTED,
  maintenance = LIQUIDATION_MAINTENANCE,
): number | null {
  if (cost === null || !Number.isFinite(cost) || cost <= 0) return null;
  return +(cost * ratio * maintenance).toFixed(2);
}

/** 依代號（.TWO=上櫃）決定融資成數 */
export function marginRatioForSymbol(symbol: string): number {
  return /\.TWO$/i.test(symbol) ? MARGIN_RATIO_OTC : MARGIN_RATIO_LISTED;
}
