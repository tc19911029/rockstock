// ============================================================
// 三色資金 — 大盤 regime（上證指數擇時閘門）
//
// 回測證據（scripts/cn-sanse-combo-grid.ts，4.2萬筆多頭樣本）：只在「多頭日」買第一檔，
// 5日期望 +0.32%；盤整/空頭日 −0.5%/−0.26%。擇時是比挑組合更穩定的賺錢開關，
// 所以頁面用此燈號提醒：多頭才積極買、盤整/空頭收手。
//
// 定義（as-of，無 lookahead）：上證(000001.SS) 收盤 vs MA20/MA60
//   多頭 bull = 收 > MA20 且 收 > MA60
//   空頭 bear = 收 < MA20 且 收 < MA60
//   盤整 chop = 其餘
// ============================================================

import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';

export type MarketRegime = 'bull' | 'chop' | 'bear';

export interface RegimeResult {
  regime: MarketRegime;
  asOf: string;          // 實際採用的指數日期（截到 asOfDate）
  close: number;
  ma20: number | null;
  ma60: number | null;
}

const INDEX_SYMBOL = '000001.SS';

/** 取上證指數截到 asOfDate（含）的 regime；不給 date → 取最新一日。歷史不足 60 根回 null。 */
export async function getMarketRegime(asOfDate?: string): Promise<RegimeResult | null> {
  const candles = await loadLocalCandles(INDEX_SYMBOL, 'CN');
  if (!candles || candles.length === 0) return null;
  const rows = asOfDate ? candles.filter((c) => c.date <= asOfDate) : candles;
  if (rows.length < 60) return null;
  const i = rows.length - 1;
  const close = rows[i].close;
  const sma = (n: number): number | null =>
    rows.length >= n ? rows.slice(i - n + 1, i + 1).reduce((a, c) => a + c.close, 0) / n : null;
  const ma20 = sma(20);
  const ma60 = sma(60);
  let regime: MarketRegime = 'chop';
  if (ma20 != null && ma60 != null) {
    if (close > ma20 && close > ma60) regime = 'bull';
    else if (close < ma20 && close < ma60) regime = 'bear';
  }
  return {
    regime,
    asOf: rows[i].date,
    close: +close.toFixed(2),
    ma20: ma20 != null ? +ma20.toFixed(2) : null,
    ma60: ma60 != null ? +ma60.toFixed(2) : null,
  };
}
