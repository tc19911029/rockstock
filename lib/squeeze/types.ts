/**
 * 軋空壓力分析（Short-Squeeze Pressure）型別
 *
 * 「空方成本」全部用「張」當單位（FinMind FinmindChipExtras toLots 已轉換）；
 * VWAP（當日均價）= 成交金額 / 成交股數，FinMind TaiwanStockPrice 提供。
 */

export interface MarginDay {
  date: string;
  marginBalance: number;   // 融資餘額（張）
  marginNet: number;       // 融資增減
  shortBalance: number;    // 融券餘額（張）
  shortNet: number;        // 融券增減
  marginUtilRate: number;  // 融資使用率 %
}

export interface SblDay {
  date: string;
  lendingBalance: number;  // 借券賣出餘額（張）
  lendingNet: number;      // 借券賣出淨增減（張）
}

export interface PriceDay {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;          // 股
  turnover: number;        // 成交金額（元）
  vwap: number;            // turnover / volume；turnover 缺則用 (H+L+C)/3
}

/** 加權平均空方成本（5/10/20/60d × 融券/借券/綜合） */
export interface ShortCostBuckets {
  margin: { d5: number | null; d10: number | null; d20: number | null; d60: number | null };
  sbl:    { d5: number | null; d10: number | null; d20: number | null; d60: number | null };
  combined: { d5: number | null; d10: number | null; d20: number | null; d60: number | null };
}

export interface SqueezeSubScores {
  shortAccumulation: number;     // 0-20 空單累積
  priceFloorRising: number;      // 0-20 跌不下去
  aboveShortCost: number;        // 0-20 站上空方成本
  marginCallPressure: number;    // 0-20 回補壓力
  breakoutVolume: number;        // 0-20 量價突破
  total: number;                 // 0-100
  level: 'low' | 'mild' | 'potential' | 'high' | 'extreme';
  levelLabel: string;            // 中文
}

export interface SqueezeAnalysis {
  symbol: string;
  name: string;
  asOfDate: string;
  close: number;                 // 最新收盤

  // 空方成本（按 spec 計算）
  shortCosts: ShortCostBuckets;

  // 當前股價相對綜合成本漲跌幅 %（正值=空方浮虧）
  vsCostPct: { d5: number | null; d10: number | null; d20: number | null; d60: number | null };

  // 餘額
  marginBalance: number;
  shortBalance: number;
  shortBalanceChange5d: number;
  shortBalanceChange20d: number;
  lendingBalance: number;
  lendingBalanceChange5d: number;
  lendingBalanceChange20d: number;

  // 追繳壓力
  marginCallPrice: number | null;       // 推估融券追繳壓力價
  distanceToMarginCallPct: number | null; // 當前股價距追繳價 %

  // 分數 + 解讀
  score: SqueezeSubScores;
  interpretation: string;        // 規則式產生的白話解讀
  warnings: string[];            // 固定 6 條風險提示

  // metadata
  dataCompleteness: {
    marginDays: number;
    sblDays: number;
    priceDays: number;
  };
}
