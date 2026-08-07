export type ValuationMarket = 'TW' | 'CN';

export function detectValuationMarket(symbol: string): ValuationMarket | null {
  const bare = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  if (/\.(SS|SZ)$/i.test(symbol)) return /^\d{6}$/.test(bare) ? 'CN' : null;
  if (/\.(TW|TWO)$/i.test(symbol)) return /^\d{4,5}$/.test(bare) ? 'TW' : null;
  if (/^\d{6}$/.test(bare)) return 'CN';
  if (/^\d{4,5}$/.test(bare)) return 'TW';
  return null;
}
