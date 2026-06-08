import type { StockSentiment } from '@/lib/youtube/analysisStorage';

/**
 * YouTube 立場（sentiment）中文標籤 + 排序優先序 — 單一事實來源。
 *
 * 由 YoutubeStockCard（首頁「YouTube 提及」卡）與 YoutubeProgramStocks
 * （/health > YouTube tab 的「各節目談了哪些股票」）共用，確保兩處
 * 「看多/看空/觀察/風險/中立/提及」用字與顏色一致。
 */
export const SENTIMENT_LABEL: Record<string, { text: string; cls: string }> = {
  bullish:        { text: '看多', cls: 'text-bull' },
  bearish:        { text: '看空', cls: 'text-bear' },
  watchlist:      { text: '觀察', cls: 'text-yellow-400' },
  risk_warning:   { text: '風險', cls: 'text-orange-400' },
  neutral:        { text: '中立', cls: 'text-muted-foreground' },
  mentioned_only: { text: '提及', cls: 'text-muted-foreground' },
};

/** 強 → 弱：看多 > 看空 > 風險 > 觀察 > 中立 > 僅提及（卡片摘要挑選 / 排序用）。 */
export const SENTIMENT_ORDER: Record<string, number> = {
  bullish: 1, bearish: 2, risk_warning: 3, watchlist: 4, neutral: 5, mentioned_only: 6,
};

/** sentiment 的排序權重（數字越小越「強」）；未知值排最後。 */
export function sentimentRank(s: StockSentiment | string): number {
  return SENTIMENT_ORDER[s] ?? 9;
}
