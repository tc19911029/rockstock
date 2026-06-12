/**
 * GET /api/overseas/peers — 海外同業對照（純顯示層）
 *
 * 回傳每個題材的 { 台股成分, 海外領先股 } 的 d1/d5/d20/d60 報酬（%、1 位小數），
 * 報酬從儲存的日K現算（不持久化）：
 *   - 台股端：讀 L1 data/candles/TW/{symbol}.json（readCandleFile）
 *   - 海外端：讀 data/overseas/candles/{ticker}.json（fetch-global-peers cron 落地）
 *
 * 缺資料 → 該檔各 horizon 回 null（前端顯示 '–'），不擋整體回應。
 */
import { apiOk, apiError } from '@/lib/api/response';
import { PEER_THEMES, PEER_REFERENCE_TICKERS } from '@/lib/scanner/peerMap';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { readOverseasCandles } from '@/lib/overseas/peerCandleStorage';
import { computeHorizonReturns, EMPTY_RETURNS, type HorizonReturns } from '@/lib/overseas/peerReturns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TWStockRow extends HorizonReturns {
  symbol: string;
  code: string;
  name: string;
}

interface OverseasRow extends HorizonReturns {
  ticker: string;
  name: string;
}

async function twReturns(symbol: string): Promise<HorizonReturns> {
  try {
    const file = await readCandleFile(symbol, 'TW');
    return computeHorizonReturns(file?.candles);
  } catch {
    return EMPTY_RETURNS;
  }
}

async function overseasReturns(ticker: string): Promise<HorizonReturns> {
  try {
    const file = await readOverseasCandles(ticker);
    return computeHorizonReturns(file?.candles);
  } catch {
    return EMPTY_RETURNS;
  }
}

export async function GET() {
  try {
    const themes = await Promise.all(
      PEER_THEMES.map(async (t) => {
        const twStocks: TWStockRow[] = await Promise.all(
          t.twStocks.map(async (s) => ({
            symbol: s.symbol, code: s.code, name: s.name,
            ...(await twReturns(s.symbol)),
          })),
        );
        const overseas: OverseasRow[] = await Promise.all(
          t.overseas.map(async (o) => ({
            ticker: o.ticker, name: o.name,
            ...(await overseasReturns(o.ticker)),
          })),
        );
        return { id: t.id, theme: t.theme, note: t.note ?? null, twStocks, overseas };
      }),
    );

    const reference: OverseasRow[] = await Promise.all(
      PEER_REFERENCE_TICKERS.map(async (o) => ({
        ticker: o.ticker, name: o.name,
        ...(await overseasReturns(o.ticker)),
      })),
    );

    return apiOk({ generatedAt: new Date().toISOString(), themes, reference });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err), 500);
  }
}
