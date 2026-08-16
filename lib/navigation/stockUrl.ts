const MARKET_SUFFIX_RE = /\.(TW|TWO|SS|SZ)$/i;

/**
 * Compare a user-entered bare code with a resolved ticker without confusing
 * same-code instruments from different exchanges (000001.SS !== 000001.SZ).
 */
export function isSameStockSymbol(left: string, right: string): boolean {
  const a = left.trim().toUpperCase();
  const b = right.trim().toUpperCase();
  if (a === b) return true;

  const aSuffix = a.match(MARKET_SUFFIX_RE)?.[1];
  const bSuffix = b.match(MARKET_SUFFIX_RE)?.[1];
  if (aSuffix && bSuffix) return false;

  return a.replace(MARKET_SUFFIX_RE, '') === b.replace(MARKET_SUFFIX_RE, '');
}

/**
 * Build the canonical chart URL after an explicit stock search.
 * `load` is the single stock source of truth; stale aliases and historical
 * dates are removed so refresh/share cannot reopen a different stock or date.
 */
export function buildStockLoadHref(
  pathname: string,
  currentSearch: string,
  resolvedTicker: string,
  timeframe: string,
): string {
  const params = new URLSearchParams(currentSearch);
  params.set('load', resolvedTicker);
  params.delete('symbol');
  params.delete('date');
  params.set('tf', timeframe);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
