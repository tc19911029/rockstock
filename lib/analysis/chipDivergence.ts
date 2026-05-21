/**
 * 量價背離訊號偵測 — 走圖頂部 banner 顯示用
 *
 * 來源（書本對齊）：
 *   - 朱家泓《活用技術分析寶典》p.57 戒律 3「量價背離 + KD 高檔 + 乖離過大」之背離部分
 *   - 《做對 5 個實戰步驟》量價 13 條：「沒有量能：上漲行進中量縮或量價背離」
 *   - docs/STRATEGY_BOOK_REFERENCE.md:102「量價背離（近 3 日漲>5% + 縮量）」
 *   - docs/TECHNICAL_ANALYSIS_5STEPS.md:1166 末端反轉「大量不漲或下跌或量價背離」
 *
 * 定義（書本標準）：
 *   - 空頭背離（頂部警示，動能衰竭）：近 3 日價漲 > 5% + 今日量 < 昨日量
 *   - 多頭背離（底部訊號，賣壓衰竭）：近 3 日價跌 > 5% + 今日量 < 昨日量
 *
 * 本檔只在 /api/stock/chips 走圖頂部 banner 顯示，**不**進入選股流程；
 * 選股的「量價背離」判定在 lib/rules/entryProhibitions.ts 戒律 3，共用同一書本門檻。
 *
 * ⚠️ 自創量化部分：5% 漲跌幅門檻（書本只說「量價背離」未量化），
 *    與 entryProhibitions.ts:23 VOL_PRICE_DIVERGENCE_GAIN_PCT 保持一致。
 */

export interface ChipDivergenceResult {
  /** 訊號類型：bullish=多頭背離（價跌量縮，賣壓衰竭），bearish=空頭背離（價漲量縮，動能衰竭） */
  type: 'bullish' | 'bearish' | null;
  /** N 日收盤價變化 % */
  priceChangePct: number;
  /** 今日量 vs 昨日量變化 %（負值=縮量） */
  volumeChangePct: number;
  /** 訊號強度 0-3 */
  strength: 0 | 1 | 2 | 3;
  /** 人類可讀說明 */
  detail: string;
}

interface PriceVolCandle {
  date: string;
  close: number;
  volume: number;
}

/**
 * 偵測單支股票的量價背離（朱家泓書本定義）。
 *
 * @param candles 升冪 by date 的 K 線（需 close + volume）
 * @param windowDays 觀察區間（書本標準 3 日）
 * @param minPriceMove 最小價格變化門檻 %（書本未量化，沿用 entryProhibitions.ts 5%）
 */
export function detectChipDivergence(
  candles: PriceVolCandle[],
  windowDays = 3,
  minPriceMove = 5,
): ChipDivergenceResult {
  const empty: ChipDivergenceResult = {
    type: null, priceChangePct: 0, volumeChangePct: 0, strength: 0, detail: '',
  };
  if (candles.length < windowDays + 1) return empty;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const ref = candles[candles.length - 1 - windowDays];
  if (!last || !prev || !ref || ref.close <= 0 || prev.volume <= 0) return empty;

  const priceChangePct = +(((last.close - ref.close) / ref.close) * 100).toFixed(2);
  const volumeChangePct = +(((last.volume - prev.volume) / prev.volume) * 100).toFixed(2);

  const priceUp = priceChangePct >= minPriceMove;
  const priceDown = priceChangePct <= -minPriceMove;
  const volumeShrink = volumeChangePct < 0; // 今日量 < 昨日量

  // 空頭背離：價漲 + 量縮（動能衰竭，頂部警示）
  if (priceUp && volumeShrink) {
    const strength = Math.min(3,
      Math.floor(priceChangePct / 5) + Math.floor(Math.abs(volumeChangePct) / 20),
    ) as 0 | 1 | 2 | 3;
    return {
      type: 'bearish',
      priceChangePct,
      volumeChangePct,
      strength,
      detail: `${windowDays}日漲 ${priceChangePct.toFixed(1)}% 但今日量縮 ${Math.abs(volumeChangePct).toFixed(0)}%（動能衰竭）`,
    };
  }

  // 多頭背離：價跌 + 量縮（賣壓衰竭，底部訊號）
  if (priceDown && volumeShrink) {
    const strength = Math.min(3,
      Math.floor(Math.abs(priceChangePct) / 5) + Math.floor(Math.abs(volumeChangePct) / 20),
    ) as 0 | 1 | 2 | 3;
    return {
      type: 'bullish',
      priceChangePct,
      volumeChangePct,
      strength,
      detail: `${windowDays}日跌 ${Math.abs(priceChangePct).toFixed(1)}% 但今日量縮 ${Math.abs(volumeChangePct).toFixed(0)}%（賣壓衰竭）`,
    };
  }

  return { ...empty, priceChangePct, volumeChangePct };
}
