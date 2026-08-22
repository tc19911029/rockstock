import { expectedTwSymbol } from '@/lib/datasource/twSymbolMarket';
import { cnNameWithTimeout, twNameWithTimeout } from '@/lib/datasource/nameWithTimeout';
import { isPlaceholderStockName, stockCodeOf } from './stockIdentity';

export type StockIdentityMarket = 'TW' | 'CN' | 'unknown';

export interface ResolvedStockIdentity {
  requestedSymbol: string;
  canonicalSymbol: string;
  code: string;
  market: StockIdentityMarket;
  name: string | null;
}

function inferMarket(symbol: string, marketHint?: 'TW' | 'CN'): StockIdentityMarket {
  if (/\.(TW|TWO)$/i.test(symbol)) return 'TW';
  if (/\.(SS|SZ)$/i.test(symbol)) return 'CN';
  if (marketHint) return marketHint;
  if (/^\d{6}$/.test(symbol)) return 'CN';
  if (/^\d{4,5}[A-Z]?$/.test(symbol)) return 'TW';
  return 'unknown';
}

function canonicalCnSymbol(code: string, requested: string): string {
  if (/\.(SS|SZ)$/i.test(requested)) return requested.toUpperCase();
  return `${code}.${code[0] === '6' || code[0] === '9' ? 'SS' : 'SZ'}`;
}

/**
 * 將使用者輸入解析成 canonical symbol 與正式名稱。
 * providedName 只有在不是空白／代號占位時才會被採用。
 */
export async function resolveStockIdentity(args: {
  symbol: string;
  marketHint?: 'TW' | 'CN';
  providedName?: string | null;
  nameBudgetMs?: number;
}): Promise<ResolvedStockIdentity> {
  const requestedSymbol = args.symbol.trim().toUpperCase();
  const code = stockCodeOf(requestedSymbol);
  const market = inferMarket(requestedSymbol, args.marketHint);

  let canonicalSymbol = requestedSymbol;
  if (market === 'TW') {
    const seeded = /\.(TW|TWO)$/i.test(requestedSymbol) ? requestedSymbol : `${code}.TW`;
    canonicalSymbol = (await expectedTwSymbol(seeded)) ?? seeded;
  } else if (market === 'CN') {
    canonicalSymbol = canonicalCnSymbol(code, requestedSymbol);
  }

  let name = isPlaceholderStockName(args.providedName, canonicalSymbol)
    ? null
    : args.providedName!.trim();

  if (!name && market === 'TW') {
    name = await twNameWithTimeout(code, args.nameBudgetMs);
  } else if (!name && market === 'CN') {
    const suffix = canonicalSymbol.endsWith('.SS') ? 'SS' : canonicalSymbol.endsWith('.SZ') ? 'SZ' : undefined;
    name = await cnNameWithTimeout(code, suffix, args.nameBudgetMs);
  }

  if (isPlaceholderStockName(name, canonicalSymbol)) name = null;
  return { requestedSymbol, canonicalSymbol, code, market, name };
}
