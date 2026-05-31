/**
 * 百度財經 CN 日K Provider —— 走圖/下載的備援源（不封IP，對 EastMoney/騰訊限流時有用）。
 *
 * 端點：https://finance.pae.baidu.com/selfselect/getstockquotation
 *   code=600519（純 6 位，無後綴）、ktype=1（日K）、group=quotation_kline_ab、all=1（全段）
 *   回傳 Result.newMarketData.marketData：`;` 分隔列，每列 `,` 分隔：
 *     [0]时间戳 [1]日期 [2]开 [3]收 [4]成交量(股) [5]高 [6]低 [7]成交额 ...
 *
 * 校準（2026-05-31 三方驗證）：百度 OHLC = 騰訊qfq = 本地 L1（前复权一致）；
 *   成交量單位「股」= repo 基準（騰訊「手」需 ×100、百度不用換）。可直接 drop-in。
 */

import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { globalCache } from './MemoryCache';
import { aggregateCandles } from './aggregateCandles';

const API = 'https://finance.pae.baidu.com/selfselect/getstockquotation';
const HISTORICAL_TTL = 24 * 60 * 60 * 1000;
const RECENT_TTL = 5 * 60 * 1000;

function extractCNCode(symbol: string): string | null {
  const m = symbol.match(/^(\d{6})\.(SS|SZ)$/i) ?? symbol.match(/^(\d{6})$/);
  return m ? m[1] : null;
}

function periodToStart(period: string): string {
  const d = new Date();
  const num = parseInt(period, 10) || 2;
  if (period.endsWith('mo')) d.setMonth(d.getMonth() - num);
  else if (period.endsWith('y')) d.setFullYear(d.getFullYear() - num);
  else d.setFullYear(d.getFullYear() - 2);
  return d.toISOString().slice(0, 10);
}

export class BaiduHistProvider {
  async getHistoricalCandles(
    symbol: string,
    period = '2y',
    asOfDate?: string,
    interval?: string,
  ): Promise<CandleWithIndicators[]> {
    const code = extractCNCode(symbol);
    if (!code) return []; // 百度此 provider 僅做 CN

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const isHistorical = !!asOfDate && asOfDate < today;
    const cacheKey = `baidu:hist:${symbol}:${period}:${interval ?? '1d'}:${asOfDate ?? 'live'}`;
    const cached = globalCache.get<CandleWithIndicators[]>(cacheKey);
    if (cached) return cached;

    const start = periodToStart(period);
    const url = `${API}?code=${code}&all=1&ktype=1&group=quotation_kline_ab` +
      `&finClientType=pc&isfromXJ=1&newFormat=1&start_time=${start}`;

    let raw: Candle[];
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) return [];
      const text = await res.text();
      let json: { Result?: { newMarketData?: { marketData?: string } } };
      try { json = JSON.parse(text); } catch { return []; } // 限流/HTML → 優雅空
      const md = json.Result?.newMarketData?.marketData;
      if (!md) return [];
      raw = [];
      for (const row of md.split(';')) {
        const p = row.split(',');
        if (p.length < 7) continue;
        const date = p[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (asOfDate && date > asOfDate) continue;
        const o = +p[2], c = +p[3], v = +p[4], h = +p[5], l = +p[6];
        if (![o, h, l, c].every(Number.isFinite) || o <= 0) continue;
        raw.push({ date, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? Math.round(v) : 0 });
      }
    } catch {
      return [];
    }

    if (raw.length === 0) return [];
    const result = computeIndicators(aggregateCandles(raw, interval));
    globalCache.set(cacheKey, result, isHistorical ? HISTORICAL_TTL : RECENT_TTL);
    return result;
  }
}

export const baiduHistProvider = new BaiduHistProvider();
