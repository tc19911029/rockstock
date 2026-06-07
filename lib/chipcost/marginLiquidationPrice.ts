/**
 * 融資（多方）斷頭／追繳壓力價
 *
 *   融資維持率 = 現價 / (融資成本 × 融資成數)
 *   斷頭價(130%) = maintenance × ratio × cost   → 上市 0.6 → 0.78 × cost
 *   追繳價(140%) = 1.40 × ratio × cost            → 上市 0.6 → 0.84 × cost
 *
 * ⚠️ 注意：與融券（空方）公式「結構不同」。
 *   空方嘎空價 = cost × (1 + 保證金成數0.9) / 1.3 ≈ 1.46 × cost（價漲觸發）
 *   多方斷頭價 = cost × 成數0.6 × 1.3 = 0.78 × cost（價跌觸發）
 *
 * ⚠️ 維持率券商是看「整戶」，不是「個股」；此價僅為單股理論估算壓力區，非強制斷頭點。
 */

/** 上市融資成數 60% */
export const MARGIN_RATIO_LISTED = 0.6;
/** 上櫃融資成數 50% */
export const MARGIN_RATIO_OTC = 0.5;
/** 斷頭維持率門檻 130% */
export const LIQUIDATION_MAINTENANCE = 1.3;
/** 追繳警戒維持率門檻 140% */
export const MARGIN_CALL_MAINTENANCE = 1.4;

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
