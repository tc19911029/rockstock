import { CandleWithIndicators } from '@/types';
import { ruleEngine } from '@/lib/rules/ruleEngine';
import { evaluateSixConditions, detectTrend, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import { StockScanResult, MarketConfig, TriggeredRule } from './types';

const CONCURRENCY = 15; // parallel requests per chunk

export abstract class MarketScanner {
  abstract getMarketConfig(): MarketConfig;
  abstract getStockList(): Promise<Array<{ symbol: string; name: string }>>;
  abstract fetchCandles(symbol: string, asOfDate?: string): Promise<CandleWithIndicators[]>;

  private async scanOne(
    symbol: string,
    name: string,
    config: MarketConfig,
    asOfDate?: string,
  ): Promise<StockScanResult | null> {
    try {
      const candles = await this.fetchCandles(symbol, asOfDate);
      if (candles.length < 30) return null;

      const lastIdx  = candles.length - 1;
      const last     = candles[lastIdx];
      const prev     = candles[lastIdx - 1];
      const signals  = ruleEngine.evaluate(candles, lastIdx);
      const sixConds = evaluateSixConditions(candles, lastIdx);
      const trend    = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);

      // ── 朱老師篩股硬性條件 ──────────────────────────────────────────────────
      // 1. 空頭趨勢：嚴禁做多
      if (trend === '空頭') return null;
      // 2. 最低分數門檻：書中六大條件必須達4項以上才值得關注
      if (sixConds.totalScore < 4) return null;
      // 3. 乖離過大：收盤超過MA20的20%屬末升段禁追高（書中明確警告）
      if (last.ma20 && last.ma20 > 0) {
        const overExtended = (last.close - last.ma20) / last.ma20 > 0.20;
        if (overExtended) return null;
      }
      // 4. KD超買：KD>88時不宜進場，此時做多風險極大
      if (last.kdK != null && last.kdK > 88) return null;

      const changePercent = prev?.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
        : 0;

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId:     s.ruleId,
        ruleName:   s.label,
        signalType: s.type,
        reason:     s.description,
      }));

      return {
        symbol,
        name,
        market: config.marketId,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules,
        sixConditionsScore: sixConds.totalScore,
        sixConditionsBreakdown: {
          trend:     sixConds.trend.pass,
          position:  sixConds.position.pass,
          kbar:      sixConds.kbar.pass,
          ma:        sixConds.ma.pass,
          volume:    sixConds.volume.pass,
          indicator: sixConds.indicator.pass,
        },
        trendState: trend,
        trendPosition: position,
        scanTime: asOfDate ? `${asOfDate}T00:00:00.000Z` : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /** Scan a provided sub-list of stocks (used by chunked parallel scanning) */
  async scanList(stocks: Array<{ symbol: string; name: string }>): Promise<StockScanResult[]> {
    return this._scanChunk(stocks, undefined);
  }

  /** Scan a provided sub-list of stocks as of a specific historical date (backtest mode) */
  async scanListAtDate(
    stocks: Array<{ symbol: string; name: string }>,
    asOfDate: string,
  ): Promise<StockScanResult[]> {
    return this._scanChunk(stocks, asOfDate);
  }

  private async _scanChunk(
    stocks: Array<{ symbol: string; name: string }>,
    asOfDate: string | undefined,
  ): Promise<StockScanResult[]> {
    const config = this.getMarketConfig();
    const results: StockScanResult[] = [];
    const DEADLINE = Date.now() + 110_000; // 110s per chunk

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      if (Date.now() > DEADLINE) {
        console.warn(`[${config.marketId}] Chunk timeout after ${i}/${stocks.length} stocks`);
        break;
      }
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name }) => this.scanOne(symbol, name, config, asOfDate))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }
    return results;
  }

  async scan(): Promise<{ results: StockScanResult[]; partial: boolean }> {
    const config = this.getMarketConfig();
    const stocks = await this.getStockList();
    const results: StockScanResult[] = [];
    // Leave 30s buffer before Vercel's 300s hard limit
    const DEADLINE = Date.now() + 240_000;

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      if (Date.now() > DEADLINE) {
        console.warn(`[${config.marketId}] Scan timeout after ${results.length} hits from ${i}/${stocks.length} stocks`);
        const sorted = results.sort((a, b) =>
          b.sixConditionsScore !== a.sixConditionsScore
            ? b.sixConditionsScore - a.sixConditionsScore
            : b.changePercent - a.changePercent
        );
        return { results: sorted, partial: true };
      }
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name }) => this.scanOne(symbol, name, config))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
    }

    return {
      results: results.sort((a, b) =>
        b.sixConditionsScore !== a.sixConditionsScore
          ? b.sixConditionsScore - a.sixConditionsScore
          : b.changePercent - a.changePercent
      ),
      partial: false,
    };
  }
}
