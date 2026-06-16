/**
 * 「法人偷買(原)」策略 — 型別（2026-06-14 重建最初版）
 *
 * ⚠️ 自創因子，刻意隔離在 lib/inststeal/，不進書本選股鏈路（鐵則 #5）。
 * 鏡像 lib/smartmoney（W）/ lib/instdip（X）/ lib/cn-sanse 的隔離先例。
 *
 * 三條件同時成立（使用者描述的「最初版」定義）：
 *   1. 股價在跌（近 dropWin 日報酬 < dropMax）
 *   2. 5 日籌碼集中度「慢慢在增加」（主力分點集中度比 concRiseBack 日前高、未爆量、未過高；
 *      concRequirePositive=true 時另需 > 0）
 *   3. 法人陸續買進（三大法人合計近 instWin 日淨買超 > 0 且連買 ≥ instConsecMin 天）
 *
 * 定位＝看盤觀察清單，不接主掃描/排行榜/scan-parity 合約。
 * ⚠️ 誠實：記憶 [[smartmoney_dip_strategy]] / [[smartmoney_instdip_intersection_no_edge]] 指出
 *   「跌+集中+法人買」這組合扣成本後超額幾乎 0、贏大盤 <50%。頁面把回測數字誠實附上，觀察用非明牌。
 *
 * 集中度公式（同 lib/smartmoney 單一事實）：
 *   集中度 =（區間前15大券商買超 − 賣超）÷ 區間成交量 × 100%
 *   主力分點 netDifference 與 candle volume 皆「張」→ 直接 Σ淨/Σ量×100，不可再 ×1000。
 */

/** 選股參數（單一事實） */
export interface InstStealParams {
  /** 「在跌」回看天數 */
  dropWin: number;
  /** 近 dropWin 日報酬 < 此值算「在跌」(%) */
  dropMax: number;
  /** 籌碼集中度窗（使用者指定 5 日） */
  concWin: number;
  /** 與「幾日前」比，判斷集中度「在增加」 */
  concRiseBack: number;
  /** 集中度警示門檻%（> 此值＝過高/疑隔日沖鎖股；2026-06-16 改「警示」不再剔除） */
  concCap: number;
  /** 量比警示門檻（今日量 ÷ 20日均量），≥ 此值＝爆量；2026-06-16 改「警示」不再剔除 */
  volRatioMax: number;
  /** 法人近 N 日累計淨買超的回看天數 */
  instWin: number;
  /** 法人合計「連買」最少天數（陸續買進） */
  instConsecMin: number;
  /** 集中度「在爬」是否要求 > 0（true=必須翻正才算；
   *  false=只要比 concRiseBack 日前高、即使仍為負（還在賣但少賣＝慢慢回升）也算在爬）。
   *  2026-06-15 使用者決議改 false：放寬讓「集中度回升中但還沒翻正」也入選（如 6691 @ 06-10）。
   *  ⚠️ 誠實附記：放寬後回測選股多一倍但品質下降（持20日 超額 +0.72%→+0.10%、贏面 56%→54%、
   *     持10日超額由正翻負），見 scripts/compare-inststeal-concpos.ts。屬看盤觀察清單、非自動買進依據。 */
  concRequirePositive: boolean;
}

export const DEFAULT_PARAMS: InstStealParams = {
  dropWin: 5,
  dropMax: -2,
  concWin: 5,
  concRiseBack: 5,
  concCap: 12,
  volRatioMax: 2,
  instWin: 5,
  instConsecMin: 2,
  concRequirePositive: false, // 2026-06-15 放寬：負但回升中也算「在爬」
};

/** 單檔命中結果 */
export interface InstStealHit {
  code: string;
  name: string;
  /** 收盤價（資料日） */
  price: number;
  /** 近 dropWin 日漲跌% (負=在跌) */
  drop5: number;
  /** 主力分點 concWin 日集中度%（>0 且在增加） */
  conc5: number;
  /** concRiseBack 日前的 concWin 日集中度%（用來看「在增加」） */
  conc5prev: number;
  /** 量比（今日量 ÷ 20日均量） */
  volRatio: number;
  /** 三大法人 instWin 日合計淨買超(張，正=逆勢買) */
  instSumK: number;
  /** 三大法人合計連續買超天數 */
  instConsecDays: number;
}

/** 一日全市場掃描結果（存成 data/inststeal/{date}.json） */
export interface InstStealDay {
  date: string;
  generatedAt: string;
  params: InstStealParams;
  /** 掃描涵蓋股票數（有法人+主力分點+日K 三者齊備的） */
  universe: number;
  hits: InstStealHit[];
}
