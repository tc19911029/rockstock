import { NextRequest } from 'next/server';
import { fetchCompanyNews } from '@/lib/news/companyRss';
import { aggregateNews } from '@/lib/news/aggregator';
import { analyzeNewsSentiment } from '@/lib/news/sentiment';
import { twNameWithTimeout } from '@/lib/datasource/nameWithTimeout';
import { apiOk, apiError } from '@/lib/api/response';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;

  const market = request.nextUrl.searchParams.get('market') ?? 'TW';
  if (!['TW', 'CN'].includes(market) || (market === 'CN' && !/^\d{6}$/.test(ticker))) return apiError('Invalid market or CN ticker', 400);

  if (!ticker || !/^\d{4,6}$/.test(ticker)) {
    return apiError('Invalid ticker format. Expected 4–6 digit Taiwan stock code.', 400);
  }

  // Optional company name from query, or auto-lookup from TWSE name table
  let companyName = request.nextUrl.searchParams.get('name') ?? undefined;
  if (market === 'CN' && !companyName?.trim()) {
    const { loadCnStockMaster } = await import('@/lib/cn-media/stockMaster');
    companyName = (await loadCnStockMaster()).find(stock => stock.code === ticker)?.name;
    if (!companyName) return apiError('CN company name is required for unknown ticker', 400);
  }
  if (!companyName) {
    companyName = (await twNameWithTimeout(ticker)) ?? undefined;
  }

  try {
    const items = market === 'CN'
      ? await fetchCompanyNews(companyName!, 'CN')
      : await aggregateNews(ticker, companyName);
    const result = await analyzeNewsSentiment(ticker, items);
    return apiOk(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return apiError(message, 503);
  }
}
