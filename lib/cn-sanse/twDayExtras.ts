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
import type { DayExtrasArr } from './indicators';
import type { Candle } from '@/types';

export async function fetchTwDayExtras(
  symbol: string,
  candles: Candle[],
): Promise<DayExtrasArr | undefined> {
  const bare = symbol.replace(/\.(TW|TWO)$/i, '');
  const shares = await getSharesIssued(bare);
  if (!shares || shares <= 0) return undefined;
  return {
    amount: candles.map((c) => c.close * c.volume * 100),
    vol: candles.map((c) => c.volume),
    turnover: candles.map((c) => ((c.volume * 1000) / shares) * 100),
  };
}
