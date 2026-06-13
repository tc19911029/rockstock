/**
 * 買進前紅旗避雷檢查 — 跨市場共用型別
 *
 * 目的：挑出股票時自動跑一道「基本面 / 籌碼 / 治理」風險檢查，
 * 把危險訊號當「警示標」貼在候選旁邊（仿 cn-agents avoidList / pool comboBadges
 * 的「只標示不替使用者決定」哲學）。
 *
 * 設計原則：
 *  1. 純函式、零 IO — 各市場 pipeline 自己用既有 provider 把資料正規化成
 *     RedFlagInput 後呼叫 computeRedFlags（CN 走 EastMoney、TW 走 TWSE/觀測站）。
 *  2. 缺資料絕不亂插旗 — 每個欄位都是 null-able，沒有值就不亮那面旗，
 *     寧可漏報也不誤報（false-positive 會讓使用者對警示麻痺）。
 *  3. 價量型「避雷」刻意不做 — 使用者已回測證明長上影/爆量長黑反而報酬更好
 *     （avoidance_layer_price_signals_reverse）。本引擎只看基本面/籌碼/治理這類
 *     「沒被回測過、且這次真的咬到人」的硬訊號。
 *  4. 只警示、不改分數 / 不剔除 — shouldAvoid 僅供 UI 標紅與 avoidList 候選；
 *     若日後要讓紅旗改動評分/tier，必須先過回測（升級規則）。
 */

/** 紅旗代號（穩定字串，UI / 回測 key 用） */
export type RedFlagCode =
  | 'earnings_crash'          // 業績爆雷：淨利/EPS YoY 大跌
  | 'earnings_decline'        // 獲利明顯衰退（比爆雷輕）
  | 'fake_high_pe'            // 本益比虛高：PE 高是因為獲利衰退、分母失真
  | 'main_force_distributing' // 主力連續出貨
  | 'shareholder_pledge'      // 大股東高比例質押（尤其用途為償還債務）
  | 'abnormal_volatility'     // 近期交易所異常波動公告
  | 'no_analyst_coverage'     // 無券商研報追蹤（純散戶題材票）
  | 'theme_unproven';         // 題材未落地（只在研發 / 傳聞階段）

/** 嚴重度：red=硬風險、yellow=警示、info=參考 */
export type RedFlagSeverity = 'red' | 'yellow' | 'info';

/** 單面紅旗 */
export interface RedFlag {
  code: RedFlagCode;
  severity: RedFlagSeverity;
  /** 白話標題（繁中，給有閱讀障礙的使用者一眼看懂；UI chip 用） */
  label: string;
  /** 具體依據（帶數字，drill-down / tooltip 用） */
  detail: string;
}

/**
 * 紅旗判斷的正規化輸入 — 全部 null-able。
 * 各市場 pipeline 把自己的 provider 結果填進來；填不到就留 null（不亮該旗）。
 */
export interface RedFlagInput {
  // ── 基本面 ──
  /** 歸母淨利 YoY %（最新一期） */
  netProfitYoYPct?: number | null;
  /** EPS YoY %（最新一期；與 netProfit 取較嚴重者） */
  epsYoYPct?: number | null;
  /** 本益比（TTM 或動態皆可） */
  per?: number | null;

  // ── 籌碼 ──
  /** 近 N 日主力資金淨額合計（人民幣/台幣元，負=淨流出） */
  mainNetRecentCny?: number | null;
  /** 上面那個合計的視窗天數（reasons 顯示用） */
  mainFlowWindowDays?: number | null;
  /** 主力連續淨流出天數 */
  mainNetConsecOutflowDays?: number | null;

  // ── 治理 ──
  /** 單一大股東累計質押佔其持股比例 %（取最高者） */
  pledgeRatioPct?: number | null;
  /** 該筆質押用途是否含「償還債務」（缺錢訊號） */
  pledgeForRepayDebt?: boolean | null;
  /** 近期是否有交易所「異常波動」公告 */
  abnormalVolatilityRecent?: boolean | null;

  // ── 其他 ──
  /** 近 N 日券商研報數（0 = 無機構覆蓋） */
  analystReportCount?: number | null;
  /** 上面研報數的視窗天數 */
  analystReportWindowDays?: number | null;
  /**
   * 市場炒作題材的落地程度：
   * 'proven'=已貢獻營收 / 'rnd_only'=只在研發 / 'rumor'=僅論壇傳聞 / null=未知不判
   */
  themeStatus?: 'proven' | 'rnd_only' | 'rumor' | null;
  /** 題材名稱（detail 顯示用，optional） */
  themeName?: string | null;
}

/** computeRedFlags 的彙總結論 */
export interface RedFlagSummary {
  flags: RedFlag[];
  redCount: number;
  yellowCount: number;
  /** 是否建議列入避開名單（紅旗引擎的單一事實）；UI / avoidList 共用 */
  shouldAvoid: boolean;
  /** 建議避開時的一句白話原因（取最嚴重那面旗） */
  avoidReason: string | null;
}
