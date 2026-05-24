/**
 * 基本面 / 技術面 / 籌碼面 / 消息面 欄位英文 → 中文標籤
 *
 * 給 UI 各處（候選池、MultiAgent、個股詳情）共用。
 * 採「中文名 + 英文縮寫括號」格式，使用者第一眼看中文，需要對照英文 schema 還能找回。
 *
 * 加新欄位請優先寫到這裡，不要在 UI 元件內 inline 對照表。
 */

export const FIELD_LABEL_ZH: Record<string, string> = {
  // ── Technical ──
  price: '收盤價',
  changePercent: '漲跌幅',
  volume: '成交量',
  sixConditionsScore: '六條件分數',
  trendState: '趨勢狀態',
  trendPosition: '位置',
  matchedMethods: '命中買法',
  mtfWeeklyPass: '週線通過 (MTF)',
  mtfMonthlyPass: '月線通過 (MTF)',
  ma20Slope: 'MA20 斜率',
  highWinRateScore: '高勝率分數',
  winnerBullishPatterns: '飆股多頭型態',
  winnerBearishPatterns: '飆股空頭型態',

  // ── Chip ──
  chipScore: '籌碼分數',
  chipSignal: '籌碼訊號',
  chipDetail: '籌碼註記',
  foreignBuy: '外資買賣超',
  trustBuy: '投信買賣超',
  dealerBuy: '自營商買賣超',
  totalInstitutional: '三大法人合計',
  marginBalance: '融資餘額',
  marginNet: '融資增減',
  marginUtilRate: '融資使用率',
  shortBalance: '融券餘額',
  shortNet: '融券增減',
  dayTradeVolume: '當沖量',
  dayTradeRatio: '當沖比',
  largeHolderPct: '大戶持股 %',
  largeHolderChange: '大戶持股變化',
  lendingBalance: '借券餘額',
  lendingNet: '借券增減',
  largeTraderBuy: '大戶買',
  largeTraderSell: '大戶賣',
  largeTraderNet: '大戶買賣超',

  // ── Fundamental（中英對照，含英文 key、英文短名、中文 key 全收）──
  EPS: '每股盈餘 EPS',
  'EPS YoY': '每股盈餘年增率 (YoY)',
  eps: '每股盈餘 EPS',
  epsYoY: '每股盈餘年增率 (YoY)',
  grossMargin: '毛利率',
  netMargin: '淨利率',
  毛利率: '毛利率',
  淨利率: '淨利率',
  revenueLatest: '月營收',
  revenueMoM: '月營收月增率 (MoM)',
  revenueYoY: '月營收年增率 (YoY)',
  月營收: '月營收',
  '月營收 YoY': '月營收年增率 (YoY)',
  '月營收 MoM': '月營收月增率 (MoM)',
  per: '本益比 PER',
  PER: '本益比 PER',
  pbr: '股價淨值比 PBR',
  PBR: '股價淨值比 PBR',
  dividendYield: '現金殖利率',
  現金殖利率: '現金殖利率',
  產業: '產業',
  industry: '產業',

  // ── News ──
  youtube_mention_count: 'YouTube 提及次數',
  youtube_in_high_consensus: 'YouTube 高共識',
  youtube_confidence: 'YouTube 信心分數',
  rss_has_news: 'RSS 有新聞',
  rss_aggregate_sentiment: 'RSS 平均情緒',
  rss_recent_count: 'RSS 近期文章數',
  mentionCount: '提及次數',
  inHighConsensus: '高共識',
  combinedConfidence: '綜合信心',
  hasNews: '有新聞',
  aggregateSentiment: '平均情緒',
  recentCount: '近期文章數',
  sentiment: '情緒',
};

/** 取欄位中文標籤；找不到回原 key（保險不掉資料）*/
export function labelOf(key: string): string {
  return FIELD_LABEL_ZH[key] ?? key;
}

/**
 * 候選池 / signal 訊號代碼英文 → 中文短語對照。
 *
 * 給 CandidatesPoolPanel.PoolRow / pool 詳情頁的 ch.signals / f.signals 用。
 * Backend 寫入時用 snake_case 英文（chip_score_high / has_fundamental_data），
 * UI 顯示前透過 signalOf 轉成中文。
 */
const SIGNAL_LABEL_ZH: Record<string, string> = {
  // chip
  chip_score_high: '籌碼分高',
  chip_score_mid: '籌碼分中',
  chip_score_low: '籌碼分低',
  foreign_buying: '外資買超',
  foreign_selling: '外資賣超',
  trust_buying: '投信買超',
  trust_selling: '投信賣超',
  dealer_buying: '自營商買超',
  margin_overheated: '融資過熱',
  margin_decreasing: '融資減碼',
  large_holder_increasing: '大戶加碼',
  large_holder_decreasing: '大戶減碼',
  lending_increasing: '借券增加',

  // fundamental
  has_fundamental_data: '有基本面資料',
  eps_positive: '每股盈餘為正',
  eps_yoy_positive: '每股盈餘年增為正',
  revenue_yoy_high: '營收年增亮眼',
  revenue_mom_positive: '營收月增為正',
  gross_margin_high: '毛利率高',
  net_margin_high: '淨利率高',
  per_low: '本益比偏低',
  pbr_low: '股價淨值比偏低',
  dividend_yield_high: '殖利率高',

  // youtube / news
  high_consensus: '高共識',
  weak_signal: '弱訊號',
  bullish_lean: '偏多',
  bearish_lean: '偏空',
};

/** 取訊號中文；找不到回原 key（保險）*/
export function signalOf(key: string): string {
  return SIGNAL_LABEL_ZH[key] ?? key;
}
