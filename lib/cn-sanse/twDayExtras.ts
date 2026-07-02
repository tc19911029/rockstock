// ============================================================
// 台股「成交額 / 成交量 / 周轉率」— 給捕撈季節 4 級量能彩柱用。
//
// 台股術語：周轉率（= 陸股的換手率）= 成交股數 / 發行股數 × 100%。
//   - 台股 K 線 volume 單位是「張」(1張=1000股) → 成交股數 = vol張 × 1000
//   - 發行股數走 FinMind getSharesIssued（NumberOfSharesIssued，24h cache，低頻）
//   - 股本變動低頻 → 用「最新發行股數」當全段固定除數（與陸股 cnDayExtras 用最新流通股本同策略）
//
// amount 餵 close×vol×100：對齊 computeSanSeChart 內 X9 = EMA(amount)/EMA(vol)/100 ≈ 平滑成本
//   的 /100 單位假設（陸股 amount單位「元」、vol單位「手(100股)」，amount/vol/100=均價；
//   台股用 close×vol×100 等價還原出 X9≈成本，X10 偏離成本% 才正確）。
// ============================================================

import { getSharesIssued } from '@/lib/datasource/FinMindClient';
import { MA, isNum } from './tdx';
import type { DayExtrasArr } from './indicators';
import type { Candle } from '@/types';

// 指數（^TWII 等）的「換手率替身」基準常數：proxy = 今日量 ÷ 近 N 日均量 × 此常數。
// 均量日 → 1.0（落進 TW_TIER_THRESHOLDS [2.25,1.08,0.66,0.6] 的中段），爆量日 → 越過綠/黃級。
// 純顯示層、不進選股、不影響回測 → 覺得彩柱太密/太疏只要微調這個數字（過密調小、不出調大）。
const INDEX_TURNOVER_BASE = 1.0;
const INDEX_VOL_MA = 60; // 均量視窗：60 對「底部放量」較敏感（捕撈季節本意）

export async function fetchTwDayExtras(
  symbol: string,
  candles: Candle[],
): Promise<DayExtrasArr | undefined> {
  const bare = symbol.replace(/\.(TW|TWO)$/i, '');
  // 加權指數沒有「發行股數」可算周轉率 → 用「量能放大倍數」當換手率替身，把捕撈季節彩柱補出來。
  // amount/vol 公式與個股相同（X9≈成本、X10≈偏離成本% 仍正確，純看價量不需股數）。
  if (/^\^/.test(bare)) {
    const V = candles.map((c) => c.volume);
    const volMa = MA(V, INDEX_VOL_MA);
    return {
      amount: candles.map((c) => c.close * c.volume * 100),
      vol: V,
      turnover: V.map((v, i) =>
        isNum(volMa[i]) && volMa[i] > 0 ? (v / volMa[i]) * INDEX_TURNOVER_BASE : 0,
      ),
    };
  }
  const shares = await getSharesIssued(bare);
  if (!shares || shares <= 0) return undefined;
  return {
    amount: candles.map((c) => c.close * c.volume * 100),
    vol: candles.map((c) => c.volume),
    turnover: candles.map((c) => ((c.volume * 1000) / shares) * 100),
  };
}
