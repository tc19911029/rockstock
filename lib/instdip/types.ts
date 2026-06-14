/**
 * 「法人接刀」策略 — 型別（X 軌，2026-06-14 新增）
 *
 * ⚠️ 自創因子，刻意隔離在 lib/instdip/，不進書本選股鏈路（鐵則 #5）。
 * 鏡像 lib/smartmoney（W）/ lib/cn-sanse 的隔離先例。
 *
 * 規律來源：scripts/factor-grid-search.ts + best-rule-test.ts（2026-06-14，234 組合 train/test）。
 *   進場底＝「股價在跌 或 今日長黑」 + 「法人 5 日逆勢買超」（聰明錢在接刀）
 *   避雷＝剔除「大戶持股水位最高 10%」（流通量太少/大戶已吃完→系統性弱，掃描層做）
 * 實證：唯一兩年(train+test)都正的買方向；test 它選的股票漲 64%(基準59%)、平均+10.4%(大盤+6.7%)。
 *   但贏大盤仍 <50%(49%)、幅度隨行情放大 → 是「把勝率往上撥一點」的傾斜，靠賠小賺大+紀律，非明牌。
 */

/** 選股參數（單一事實，門檻來自 best-rule-test.ts） */
export interface InstDipParams {
  /** 計算「在跌」的回看天數 */
  lookback: number;
  /** 近 lookback 日漲跌 < 此值算「在跌」(%) */
  dropMax: number;
  /** 今日 (收/開−1) < 此值算「長黑」(%) — 與「在跌」取 OR */
  blackMax: number;
}

export const DEFAULT_PARAMS: InstDipParams = {
  lookback: 5,
  dropMax: -3,
  blackMax: -3,
};

/** 單檔命中結果 */
export interface InstDipHit {
  code: string;
  name: string;
  price: number;
  /** 近 lookback 日漲跌% (負=在跌) */
  drop5: number;
  /** 今日漲跌% (收/開−1，負=長黑) */
  todayChg: number;
  /** 法人 lookback 日淨買超(張，正=逆勢買) */
  inst5K: number;
  /** 大戶持股水位% (依股價挑級距 100/400/1000 張) — 顯示用，超高會被掃描層剔除/標警 */
  holderLvl: number | null;
}

/** 一日全市場掃描結果（存成 data/instdip/{date}.json 或 L4 scan session） */
export interface InstDipDay {
  date: string;
  generatedAt: string;
  params: InstDipParams;
  universe: number;
  hits: InstDipHit[];
}
