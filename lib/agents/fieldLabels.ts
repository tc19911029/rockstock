/**
 * 把多代理 reasoning 的 source/field 代碼翻成中文，給 UI 顯示用。
 *
 * 之前 /agents/[symbol]/page.tsx 有 zhSource + FIELD_LABEL_ZH 內部 helper，
 * /agents/page.tsx 沒有，所以 detail 卡片裡會漏出 `prefetch.chip.foreignBuy` 這種字眼。
 * 抽出來共用。
 */

export const FIELD_LABEL_ZH: Record<string, string> = {
  // — Technical —
  price: '收盤價',
  changePercent: '漲跌幅',
  volume: '成交量',
  sixConditionsScore: '六條件分數',
  trendState: '趨勢狀態',
  trendPosition: '位置',
  matchedMethods: '命中買法',
  mtfWeeklyPass: 'MTF 週線通過',
  mtfMonthlyPass: 'MTF 月線通過',
  ma20Slope: 'MA20 斜率',
  highWinRateScore: '高勝率分數',
  winnerBullishPatterns: '飆股多頭型態',
  winnerBearishPatterns: '飆股空頭型態',

  // — Chip —
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
  dayTradeDate: '當沖資料日',
  largeHolderPct: '大戶持股 %',
  largeHolderChange: '大戶持股變化',
  lendingBalance: '借券餘額',
  lendingNet: '借券增減',
  largeTraderBuy: '大戶買',
  largeTraderSell: '大戶賣',
  largeTraderNet: '大戶買賣超',
  brokerNetBuy: '主力分點買賣超',
  brokerConcentration: '單日主力集中度',
  brokerConcentration5d: '5 日主力集中度（近似）',
  brokerConcentration20d: '20 日主力集中度（近似）',
  brokerConcentrationCoverage5d: '5 日集中度覆蓋率',
  brokerConcentrationCoverage20d: '20 日集中度覆蓋率',
  brokerDataDate: '主力分點資料日',
  brokerConcentrationSource: '主力集中度來源',

  // — Fundamental —
  EPS: 'EPS（每股盈餘）',
  'EPS YoY': 'EPS 年增率',
  毛利率: '毛利率',
  淨利率: '淨利率',
  月營收: '月營收',
  '月營收 YoY': '月營收年增率',
  '月營收 MoM': '月營收月增率',
  PER: 'PER（本益比）',
  PBR: 'PBR（股價淨值比）',
  現金殖利率: '現金殖利率',
  產業: '產業',
  eps: 'EPS',
  epsYoY: 'EPS 年增率',
  grossMargin: '毛利率',
  netMargin: '淨利率',
  per: 'PER',
  pbr: 'PBR',
  dividendYield: '現金殖利率',
  revenueLatest: '最新月營收',
  revenueMoM: '月營收 MoM',
  revenueYoY: '月營收 YoY',

  // — News —
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

export function zhLabel(en: string): string {
  return FIELD_LABEL_ZH[en] ?? en;
}

/**
 * 把 source path（e.g. `prefetch.chip.foreignBuy`）翻成中文。
 * 未知前綴保留原文（書本 ruleId 如 c-trend, p-pattern, e-XX 不會被改）。
 */
export function zhSource(source: string): string {
  if (source.startsWith('L4.candidateRow.')) {
    return `候選池.${zhLabel(source.replace('L4.candidateRow.', ''))}`;
  }
  if (source.startsWith('prefetch.chip.')) return `籌碼.${zhLabel(source.replace('prefetch.chip.', ''))}`;
  if (source.startsWith('prefetch.fundamentals.')) return `基本面.${zhLabel(source.replace('prefetch.fundamentals.', ''))}`;
  if (source.startsWith('prefetch.fundamentals')) return `基本面.${zhLabel(source.replace('prefetch.fundamentals', ''))}`;
  if (source.startsWith('prefetch.youtube.')) return `YouTube.${zhLabel(source.replace('prefetch.youtube.', ''))}`;
  if (source.startsWith('prefetch.rss.')) return `RSS.${zhLabel(source.replace('prefetch.rss.', ''))}`;
  if (source.startsWith('groundTruth.industry')) return '候選池.產業';
  return source;
}
