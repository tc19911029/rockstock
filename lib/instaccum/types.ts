/**
 * 「法人吸·融資退」策略 — 型別（2026-06-22）
 *
 * ⚠️ 自創因子，刻意隔離在 lib/instaccum/，不進書本選股鏈路（鐵則 #5）。
 * 鏡像 lib/inststeal（Y）/ lib/smartmoney（W）/ lib/instdip（X）的隔離先例。
 *
 * 核心邏輯＝籌碼安靜換手：法人默默吸貨、散戶（融資）退場、價格還沒發動 = 潛伏吸籌。
 *
 * 三條件同時成立：
 *   1. 股價沒大漲（近 priceWin 日漲幅在 [priceFloorPct, priceMaxRisePct] 之間 —
 *      上限防「已經噴出」、軟下限防「接刀」）
 *   2. 融資大減（融資餘額較 marginWin 日前下降 ≥ |marginDropPct|%，散戶在退場）
 *   3. 法人大買（三大法人合計近 instWin 日淨買超，兩種定義擇一：
 *      consec=連買 ≥ instConsecMin 天；magnitude=買超佔成交量 ≥ instToVolPct%）
 *
 * 定位＝看盤觀察清單／研究，是否接主掃描由回測誠實 edge 決定（scripts/backtest-instaccum.ts）。
 * 與 Y 軌（lib/inststeal）差別：Y 用「主力分點集中度在爬」+「在跌」；本軌改用「融資大減」+「沒大漲」。
 * 融資是 factor-grid-search 還沒測過的全新因子。
 */

/** 法人大買的判斷方式 */
export type InstBuyMode = 'consec' | 'magnitude';

/** 選股參數（單一事實） */
export interface InstAccumParams {
  /** 條件1「沒大漲」回看天數 */
  priceWin: number;
  /** 近 priceWin 日漲幅 ≤ 此值算「沒大漲」(%) */
  priceMaxRisePct: number;
  /** 近 priceWin 日漲幅 ≥ 此值才算（軟下限，防接刀；設 -Infinity 關閉）(%) */
  priceFloorPct: number;
  /** 條件2「融資大減」回看天數 */
  marginWin: number;
  /** 融資餘額較 marginWin 日前變化 ≤ 此值算「大減」(% 負數) */
  marginDropPct: number;
  /** 條件3「法人大買」回看天數（累計淨買超 + 佔量比） */
  instWin: number;
  /** 法人大買判斷方式：連買天數 or 買超力道 */
  instMode: InstBuyMode;
  /** consec 模式：法人合計連買最少天數 */
  instConsecMin: number;
  /** magnitude 模式：instWin 日淨買超 ÷ instWin 日成交量 ≥ 此值算「大」買(%) */
  instToVolPct: number;
}

export const DEFAULT_PARAMS: InstAccumParams = {
  priceWin: 5,
  priceMaxRisePct: 5,
  priceFloorPct: -10,
  marginWin: 5,
  marginDropPct: -3,
  instWin: 5,
  instMode: 'consec',
  instConsecMin: 2,
  instToVolPct: 3,
};

/** 單檔命中結果 */
export interface InstAccumHit {
  code: string;
  name: string;
  /** 收盤價（資料日） */
  price: number;
  /** 近 priceWin 日漲跌%（沒大漲：在區間內） */
  priceChg: number;
  /** 融資餘額近 marginWin 日變化%（負＝在減） */
  marginChg: number;
  /** 當日融資餘額（張） */
  marginBalance: number;
  /** 三大法人 instWin 日合計淨買超（張，正＝在買） */
  instSumK: number;
  /** 三大法人合計連續買超天數 */
  instConsecDays: number;
  /** 法人 instWin 日買超佔成交量比% */
  instToVol: number;
  /** 命中用哪種法人大買定義 */
  instMode: InstBuyMode;
}

/** 一日全市場掃描結果（存成 data/instaccum/{date}.json 或走 L4 scan session） */
export interface InstAccumDay {
  date: string;
  generatedAt: string;
  params: InstAccumParams;
  /** 掃描涵蓋股票數（法人 + 融資 + 日K 三者齊備的） */
  universe: number;
  hits: InstAccumHit[];
}
