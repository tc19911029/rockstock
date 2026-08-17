const MARKET_TIME_ZONE = {
  TW: 'Asia/Taipei',
  CN: 'Asia/Shanghai',
} as const;

const MARKET_CLOSE_MINUTES = {
  TW: 13 * 60 + 30,
  CN: 15 * 60,
} as const;

/** L1 收盤價只能和同一交易日、收盤後寫入的 L2 最終快照比較。 */
export function isFinalTradingSnapshot(
  market: 'TW' | 'CN',
  tradingDate: string,
  updatedAt: string,
): boolean {
  const timestamp = new Date(updatedAt);
  if (Number.isNaN(timestamp.getTime())) return false;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MARKET_TIME_ZONE[market],
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(timestamp);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? '';
  const localDate = `${value('year')}-${value('month')}-${value('day')}`;
  const localMinutes = Number(value('hour')) * 60 + Number(value('minute'));

  return localDate === tradingDate && localMinutes >= MARKET_CLOSE_MINUTES[market];
}
