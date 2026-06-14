// ============================================================
// 題材×三色 — market 派發的 K 線載入（結算 + 報酬共用）。Server-only。
//
// TW：readCandleFile（{code}.TW / .TWO fallback）+ ^TWII 指數。
// CN：reuse recoPipeline 三路 K 線（主板 L1 / 創業科創 Tencent 快取 / 北交 no_data）
//     + 上證 000001.SS 指數（與陸股回測同源）。
// ============================================================

import type { BaselineCandle } from '@/lib/backtest/eventBaseline';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { loadCandlesForEvent, loadShIndexCandles } from '@/lib/cn-agents/backtest/recoPipeline';
import { bareCode, cnBoardKindFromCode } from './codes';
import { INDEX_SYMBOL_BY_MARKET, type TsMarket } from './types';

export const ymd8 = (iso: string): string => iso.replaceAll('-', '');

function toBaseline(
  candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume?: number }>,
): BaselineCandle[] {
  return candles.map((c) => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 1 }));
}

async function loadTwCandles(symbol: string): Promise<BaselineCandle[] | null> {
  const code = bareCode(symbol);
  const f =
    (await readCandleFile(symbol, 'TW')) ??
    (await readCandleFile(`${code}.TW`, 'TW')) ??
    (await readCandleFile(`${code}.TWO`, 'TW'));
  return f?.candles?.length ? toBaseline(f.candles) : null;
}

/** 載個股全段 K 線（升序）。CN 需 needUpToYmd8（成長板 Tencent 快取補抓窗）。 */
export async function loadStockCandles(
  market: TsMarket,
  symbol: string,
  needUpToYmd8?: string,
): Promise<BaselineCandle[] | null> {
  if (market === 'CN') {
    const up = needUpToYmd8 ?? ymd8(new Date().toISOString().slice(0, 10));
    return loadCandlesForEvent(symbol, cnBoardKindFromCode(bareCode(symbol)), up);
  }
  return loadTwCandles(symbol);
}

/** 載 market 指數 K 線（算超額用）。 */
export async function loadIndexCandles(market: TsMarket): Promise<BaselineCandle[] | null> {
  if (market === 'CN') return loadShIndexCandles();
  const f = await readCandleFile(INDEX_SYMBOL_BY_MARKET.TW, 'TW');
  return f?.candles?.length ? toBaseline(f.candles) : null;
}
