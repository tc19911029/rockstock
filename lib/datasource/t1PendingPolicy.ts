import type { IntradaySnapshot } from './IntradayCache';
import { isConfirmedNoTradeQuote, MIN_VERIFY_UNIVERSE } from './DownloadVerifier';
import { isFinalTradingSnapshot } from '../health/l1l2Snapshot';

/** 與 DownloadVerifier 一致：完整收盤快照缺席者分流，不推定停牌或退市原因。 */
export function classifyT1Pending<T extends { symbol: string }>(
  market: 'TW' | 'CN',
  date: string,
  entries: T[],
  snapshot: IntradaySnapshot | null,
) {
  const quotes = new Map(snapshot?.quotes.map(quote => [quote.symbol, quote]));
  const broadFinal = snapshot?.market === market && snapshot.date === date
    && snapshot.count >= MIN_VERIFY_UNIVERSE[market]
    && quotes.size >= MIN_VERIFY_UNIVERSE[market]
    && isFinalTradingSnapshot(market, date, snapshot.updatedAt);
  const pending: T[] = [];
  const confirmedNoTrade: T[] = [];
  const notTrading: T[] = [];
  const externalManaged: T[] = [];
  for (const entry of entries) {
    if (entry.symbol.startsWith('^')) {
      externalManaged.push(entry);
      continue;
    }
    const quote = quotes.get(entry.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, ''));
    if (broadFinal && !quote) notTrading.push(entry);
    else if (broadFinal && quote && isConfirmedNoTradeQuote(market, quote)) confirmedNoTrade.push(entry);
    else pending.push(entry);
  }
  return { pending, confirmedNoTrade, notTrading, externalManaged };
}
