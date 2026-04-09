/**
 * MABaseGenerator — 生成 MA Base 聚合快取
 *
 * 在收盤 cron 完成後呼叫，遍歷全市場 candle files，
 * 提取每檔股票最近 N 根收盤價和成交量，
 * 存為單一 JSON 檔供粗掃即時 MA 計算使用。
 *
 * 格式: intraday/{market}/{date}-ma-base.json
 *   { "2330": { closes: [...], volumes: [...] }, ... }
 *
 * 這讓粗掃只需多讀 1 個檔案就能算 MA，不需逐檔讀歷史。
 */

import { readCandleFile } from './CandleStorageAdapter';
import { writeMABase, MABaseSnapshot, MABaseEntry } from './IntradayCache';

/** 提取最近 N 根歷史數據 */
const MA_LOOKBACK = 20;

/** 並行讀取的批次大小 */
const READ_CONCURRENCY = 20;

/**
 * 為全市場生成 MA Base
 *
 * @param market TW 或 CN
 * @param date 最後交易日（封存日期）
 * @param stocks 股票清單（symbol + name）
 */
export async function generateMABase(
  market: 'TW' | 'CN',
  date: string,
  stocks: Array<{ symbol: string }>,
): Promise<{ total: number; succeeded: number; failed: number }> {
  const data: Record<string, MABaseEntry> = {};
  let succeeded = 0;
  let failed = 0;

  // 分批並行讀取
  for (let i = 0; i < stocks.length; i += READ_CONCURRENCY) {
    const batch = stocks.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async ({ symbol }) => {
        const candleFile = await readCandleFile(symbol, market);
        if (!candleFile || candleFile.candles.length === 0) {
          return null;
        }

        // 取最後 MA_LOOKBACK 根
        const candles = candleFile.candles.slice(-MA_LOOKBACK);
        const closes = candles.map(c => c.close);
        const volumes = candles.map(c => c.volume);

        return { symbol, closes, volumes };
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        // symbol 可能帶 .TW/.SZ 後綴，也需要存純數字碼
        // 粗掃用的 IntradayQuote.symbol 是純代碼
        const rawSymbol = r.value.symbol;
        const pureCode = rawSymbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

        data[pureCode] = {
          closes: r.value.closes,
          volumes: r.value.volumes,
        };
        // 也存帶後綴的版本（以防粗掃用帶後綴的 symbol）
        if (pureCode !== rawSymbol) {
          data[rawSymbol] = {
            closes: r.value.closes,
            volumes: r.value.volumes,
          };
        }
        succeeded++;
      } else {
        failed++;
      }
    }
  }

  const base: MABaseSnapshot = {
    market,
    date,
    updatedAt: new Date().toISOString(),
    data,
  };

  await writeMABase(base);

  const entryCount = Object.keys(data).length;
  console.info(`[MABaseGenerator] ${market} MA Base 已生成: ${entryCount} entries (${succeeded} ok, ${failed} fail) @ ${date}`);

  return { total: stocks.length, succeeded, failed };
}
