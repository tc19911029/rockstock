/**
 * 「主力分點剛開始偷買」策略 — 型別（refined 版，2026-06-14 升級）
 *
 * ⚠️ 自創因子，刻意隔離在 lib/smartmoney/，不進書本選股鏈路（鐵則 #5）。
 * 鏡像 lib/cn-sanse / lib/cn-agents 的隔離先例。
 *
 * 演進：
 *   v1 (徐黎芳粗版)：近5日跌 + 法人集中度>8% → 看集中度「高低」。
 *   v2 (肌肉書僮 refined，現行)：主力分點(前15大券商)集中度，看「由負轉正 + 濾隔日沖 + 不爆量」。
 * 為何升級：retest-crude-vs-refined.ts 三個時間窗 refined 全贏粗版（全期 +0.30 vs +0.04、
 *   近1年 +1.87 vs −0.57、近7個月 +3.10 vs −3.04）。但 refined 優勢隨樣本變大而縮、贏大盤仍 <50%
 *   → 顯示/紀律參考用，非穩定贏大盤訊號（[[smartmoney_dip_strategy]]）。
 *
 * 集中度公式（CMoney / 影片單一事實）：
 *   集中度 =（區間前15大券商買超 − 賣超）÷ 區間成交量 × 100%
 *   主力分點 netDifference 已是「張」、candle volume 也是「張」→ 直接 Σ淨/Σ量×100，不可再 ×1000。
 */

/** 選股參數（單一事實，門檻來自 retest-crude-vs-refined.ts 的 refined 條件） */
export interface SmartMoneyParams {
  /** 短線集中度窗（濾隔日沖用）天數 */
  shortWin: number;
  /** 長線（主力分點轉向）集中度窗天數 */
  longWin: number;
  /** 與「幾日前」比較判斷「由負轉正」 */
  turnBack: number;
  /** 長線集中度下限%（剛開始吃貨，太高=已吃完） */
  longMin: number;
  /** 長線集中度上限% */
  longMax: number;
  /** 短線集中度上限%（> 此值多半是隔日沖鎖股票的假象，剔除） */
  shortMax: number;
  /** 量比上限（今日量 ÷ 20日均量），> 此值=爆量，剔除 */
  volRatioMax: number;
}

export const DEFAULT_PARAMS: SmartMoneyParams = {
  shortWin: 5,
  longWin: 20,
  turnBack: 5,
  longMin: 1,
  longMax: 5,
  shortMax: 8,
  volRatioMax: 1.8,
};

/** 單檔命中結果 */
export interface SmartMoneyHit {
  code: string;
  name: string;
  /** 收盤價（資料日） */
  price: number;
  /** 主力分點 longWin 日集中度%（由負轉正後落在 1~5%） */
  conc20: number;
  /** turnBack 日前的 longWin 日集中度%（用來判斷「由負轉正」，應 ≤ 0） */
  conc20prev: number;
  /** 主力分點 shortWin 日集中度%（< shortMax 才不是隔日沖假象） */
  conc5: number;
  /** 量比（今日量 ÷ 20日均量） */
  volRatio: number;
  /** 近 shortWin 日股價漲跌%（顯示用，不再是進場 gate） */
  drop5: number;
}

/** 一日全市場掃描結果（存成 data/smartmoney/{date}.json） */
export interface SmartMoneyDay {
  date: string;
  generatedAt: string;
  params: SmartMoneyParams;
  /** 掃描涵蓋股票數 */
  universe: number;
  hits: SmartMoneyHit[];
}
