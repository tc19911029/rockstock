/**
 * R 乖離率策略回測（2026-05-21 新增，機械軌）
 *
 * 對照 lib/scanner/MarketScanner.scanDeviationExtreme 的純機械式邏輯：
 *   - 粗篩：當日成交額前 500（close × volume）
 *   - 做多：MA20 乖離率最負 top 10（升序）
 *   - 做空：MA20 乖離率最正 top 10（降序）
 *
 * 進出場：
 *   - 進場：T+1 開盤
 *   - 出場：固定持有 HOLD_DAYS 後 close（無止損止盈，純看均值回歸）
 *
 * 評估：勝率 / 平均報酬 / 中位數 / Sharpe / 最大回撤 / long-short 對稱性
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-deviation.ts
 *
 * Env:
 *   MARKET=TW|CN|both  （預設 both）
 *   DIRECTION=long|short|both  （預設 both）
 *   HOLD_DAYS=5,10,20  （CSV，預設 5,10,20）
 *   PERIOD_START / PERIOD_END  （預設 2025-04-16 ~ 2026-04-16，與 daban 對齊）
 *   TOP_N=10  （預設 10）
 *   POOL=500  （成交額池子大小，預設 500）
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

// ══════════════════════════════════════════════════════════════
// 全局設定
// ══════════════════════════════════════════════════════════════

const PERIOD = {
  start: process.env.PERIOD_START ?? '2025-04-16',
  end:   process.env.PERIOD_END   ?? '2026-04-16',
};

const TW_COST = (0.001425 * 0.6 * 2 + 0.003) * 100;  // ≈ 0.471%
const CN_COST = 0.16;

const TOP_N    = parseInt(process.env.TOP_N ?? '10', 10);
const POOL_N   = parseInt(process.env.POOL ?? '500', 10);
const HOLD_DAYS = (process.env.HOLD_DAYS ?? '5,10,20')
  .split(',').map(s => parseInt(s, 10)).filter(n => n > 0);

type Direction = 'long' | 'short';
type Market = 'TW' | 'CN';

const MARKETS: Market[] = (() => {
  const env = process.env.MARKET;
  if (env === 'TW') return ['TW'];
  if (env === 'CN') return ['CN'];
  return ['TW', 'CN'];
})();

const DIRECTIONS: Direction[] = (() => {
  const env = process.env.DIRECTION;
  if (env === 'long') return ['long'];
  if (env === 'short') return ['short'];
  return ['long', 'short'];
})();

// ══════════════════════════════════════════════════════════════
// 型別
// ══════════════════════════════════════════════════════════════

interface StockData {
  name: string;
  candles: CandleWithIndicators[];
}

interface Pick {
  symbol: string;
  name: string;
  idx: number;
  entryPrice: number;
  deviation: number;
  turnover: number;
}

interface Trade {
  symbol: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  deviation: number;
  grossPct: number;
  netPct: number;
  holdDays: number;
}

interface ComboStats {
  market: Market;
  direction: Direction;
  holdDays: number;
  tradeCount: number;
  winRate: number;
  avgReturn: number;
  medianReturn: number;
  stdReturn: number;
  sharpe: number;
  maxDD: number;
  totalReturn: number;
}

// ══════════════════════════════════════════════════════════════
// 資料載入（與 backtest-daban-all.ts 一致）
// ══════════════════════════════════════════════════════════════

function loadStocks(market: Market): Map<string, StockData> {
  const stocks = new Map<string, StockData>();

  if (market === 'TW') {
    const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
    if (!fs.existsSync(dir)) {
      console.error('TW candles 目錄不存在');
      return stocks;
    }
    process.stdout.write('  讀取 TW K線...');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        const c: CandleWithIndicators[] = Array.isArray(raw) ? raw : raw.candles ?? raw;
        if (!c || c.length < 30) continue;
        stocks.set(f.replace('.json', ''), {
          name: (raw as { name?: string }).name ?? f.replace('.json', ''),
          candles: computeIndicators(c),
        });
      } catch { /* 略 */ }
    }
    console.log(` ${stocks.size} 支`);
    return stocks;
  }

  // CN
  const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');
  if (fs.existsSync(cacheFile)) {
    process.stdout.write('  讀取 CN bulk cache...');
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    let n = 0;
    for (const [sym, d] of Object.entries(raw.stocks as Record<string, { name: string; candles: unknown[] }>)) {
      if (!d.candles || d.candles.length < 30 || d.name.includes('ST')) continue;
      try {
        stocks.set(sym, { name: d.name, candles: computeIndicators(d.candles as CandleWithIndicators[]) });
        n++;
      } catch { /* 略 */ }
    }
    console.log(` ${n} 支`);
  }
  return stocks;
}

// ══════════════════════════════════════════════════════════════
// 每日選股：top 500 turnover → top 10 deviation
// ══════════════════════════════════════════════════════════════

function pickDay(
  allStocks: Map<string, StockData>,
  stockDateIdx: Map<string, Map<string, number>>,
  date: string,
  direction: Direction,
): Pick[] {
  // 1. 收集當日有 ma20 且有報價的股票
  const dayList: Array<{ symbol: string; name: string; idx: number; close: number; volume: number; ma20: number }> = [];
  for (const [symbol, sd] of allStocks) {
    const idx = stockDateIdx.get(symbol)?.get(date);
    if (idx == null || idx < 19) continue;
    const c = sd.candles[idx];
    if (!c || c.close <= 0 || (c.volume ?? 0) <= 0) continue;
    const ma20 = c.ma20;
    if (ma20 == null || ma20 <= 0) continue;
    dayList.push({ symbol, name: sd.name, idx, close: c.close, volume: c.volume ?? 0, ma20 });
  }

  // 2. 粗篩：成交額 top POOL_N
  dayList.sort((a, b) => b.close * b.volume - a.close * a.volume);
  const pool = dayList.slice(0, POOL_N);

  // 3. 計算乖離率
  const scored: Pick[] = pool.map(s => {
    const sd = allStocks.get(s.symbol)!;
    const nextIdx = s.idx + 1;
    const next = sd.candles[nextIdx];
    if (!next || next.open <= 0) return null;
    return {
      symbol: s.symbol,
      name: s.name,
      idx: nextIdx,                            // 進場 idx 是 T+1
      entryPrice: next.open,
      deviation: (s.close - s.ma20) / s.ma20,
      turnover: s.close * s.volume,
    };
  }).filter((p): p is Pick => p != null);

  // 4. 排序取 top N
  scored.sort((a, b) =>
    direction === 'long' ? a.deviation - b.deviation : b.deviation - a.deviation,
  );
  return scored.slice(0, TOP_N);
}

// ══════════════════════════════════════════════════════════════
// 持有 holdDays 後出場（純機械）
// ══════════════════════════════════════════════════════════════

function simulateHold(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
  holdDays: number,
  direction: Direction,
): { exitIdx: number; exitPrice: number } | null {
  const exitIdx = entryIdx + holdDays - 1;
  if (exitIdx >= candles.length) return null;
  const c = candles[exitIdx];
  return {
    exitIdx,
    exitPrice: c.close,
  };
  // 注意：short 的方向已在 PnL 計算時反向處理
}

// ══════════════════════════════════════════════════════════════
// 單一組合回測
// ══════════════════════════════════════════════════════════════

function runCombo(
  market: Market,
  direction: Direction,
  holdDays: number,
  allStocks: Map<string, StockData>,
  stockDateIdx: Map<string, Map<string, number>>,
  tradingDays: string[],
): ComboStats {
  const costPct = market === 'TW' ? TW_COST : CN_COST;
  const trades: Trade[] = [];

  for (const date of tradingDays) {
    const picks = pickDay(allStocks, stockDateIdx, date, direction);
    for (const pick of picks) {
      const sd = allStocks.get(pick.symbol)!;
      const sim = simulateHold(sd.candles, pick.idx, pick.entryPrice, holdDays, direction);
      if (!sim) continue;

      // 報酬計算：long = (exit - entry) / entry；short = (entry - exit) / entry
      const rawPct = (sim.exitPrice - pick.entryPrice) / pick.entryPrice * 100;
      const grossPct = direction === 'long' ? rawPct : -rawPct;
      const netPct = grossPct - costPct;

      trades.push({
        symbol: pick.symbol,
        entryDate: sd.candles[pick.idx]?.date?.slice(0, 10) ?? '',
        exitDate: sd.candles[sim.exitIdx]?.date?.slice(0, 10) ?? '',
        entryPrice: +pick.entryPrice.toFixed(2),
        exitPrice: +sim.exitPrice.toFixed(2),
        deviation: +(pick.deviation * 100).toFixed(2),
        grossPct: +grossPct.toFixed(3),
        netPct: +netPct.toFixed(3),
        holdDays,
      });
    }
  }

  // ── 統計 ──
  const n = trades.length;
  if (n === 0) {
    return {
      market, direction, holdDays, tradeCount: 0,
      winRate: 0, avgReturn: 0, medianReturn: 0, stdReturn: 0,
      sharpe: 0, maxDD: 0, totalReturn: 0,
    };
  }
  const wins = trades.filter(t => t.netPct > 0).length;
  const returns = trades.map(t => t.netPct);
  const sumReturn = returns.reduce((a, b) => a + b, 0);
  const avgReturn = sumReturn / n;
  const sorted = [...returns].sort((a, b) => a - b);
  const medianReturn = sorted[Math.floor(n / 2)];
  const variance = returns.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / n;
  const stdReturn = Math.sqrt(variance);
  const sharpe = stdReturn > 0 ? avgReturn / stdReturn * Math.sqrt(252 / holdDays) : 0;

  // 累積回撤（等權重）
  let peak = 0;
  let maxDD = 0;
  let cum = 0;
  for (const r of returns) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    market, direction, holdDays,
    tradeCount: n,
    winRate: +((wins / n) * 100).toFixed(2),
    avgReturn: +avgReturn.toFixed(3),
    medianReturn: +medianReturn.toFixed(3),
    stdReturn: +stdReturn.toFixed(3),
    sharpe: +sharpe.toFixed(2),
    maxDD: +maxDD.toFixed(2),
    totalReturn: +sumReturn.toFixed(2),
  };
}

// ══════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════

function buildStockDateIdx(stocks: Map<string, StockData>): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const [symbol, sd] of stocks) {
    const idx = new Map<string, number>();
    for (let i = 0; i < sd.candles.length; i++) {
      const d = sd.candles[i].date?.slice(0, 10);
      if (d) idx.set(d, i);
    }
    m.set(symbol, idx);
  }
  return m;
}

function collectTradingDays(stocks: Map<string, StockData>, start: string, end: string): string[] {
  const dates = new Set<string>();
  for (const sd of stocks.values()) {
    for (const c of sd.candles) {
      const d = c.date?.slice(0, 10);
      if (d && d >= start && d <= end) dates.add(d);
    }
  }
  return [...dates].sort();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('R 乖離率策略回測');
  console.log('═══════════════════════════════════════════════════');
  console.log(`期間: ${PERIOD.start} ~ ${PERIOD.end}`);
  console.log(`市場: ${MARKETS.join('+')}`);
  console.log(`方向: ${DIRECTIONS.join('+')}`);
  console.log(`持有天數: ${HOLD_DAYS.join(', ')}`);
  console.log(`成交額池: top ${POOL_N}，最終取乖離率 top ${TOP_N}`);
  console.log();

  const allResults: ComboStats[] = [];

  for (const market of MARKETS) {
    console.log(`── ${market} ──`);
    const stocks = loadStocks(market);
    if (stocks.size === 0) {
      console.log(`  ${market} 無資料，跳過`);
      continue;
    }
    const stockDateIdx = buildStockDateIdx(stocks);
    const tradingDays = collectTradingDays(stocks, PERIOD.start, PERIOD.end);
    console.log(`  交易日: ${tradingDays.length} 個`);

    for (const direction of DIRECTIONS) {
      for (const holdDays of HOLD_DAYS) {
        process.stdout.write(`  ${market} ${direction} hold=${holdDays}... `);
        const stats = runCombo(market, direction, holdDays, stocks, stockDateIdx, tradingDays);
        allResults.push(stats);
        console.log(
          `n=${stats.tradeCount} 勝率=${stats.winRate}% 均報酬=${stats.avgReturn}% ` +
          `Sharpe=${stats.sharpe} MaxDD=${stats.maxDD}%`,
        );
      }
    }
    console.log();
  }

  // ── 摘要表 ──
  console.log('═══════════════════════════════════════════════════');
  console.log('摘要');
  console.log('═══════════════════════════════════════════════════');
  console.log('Market  Dir    Hold  Trades   勝率   均報酬   中位數   Sharpe  MaxDD   累計');
  for (const r of allResults) {
    console.log(
      `${r.market.padEnd(7)}${r.direction.padEnd(7)}${String(r.holdDays).padEnd(6)}` +
      `${String(r.tradeCount).padEnd(9)}${(r.winRate + '%').padEnd(7)}` +
      `${(r.avgReturn + '%').padEnd(9)}${(r.medianReturn + '%').padEnd(9)}` +
      `${String(r.sharpe).padEnd(8)}${(r.maxDD + '%').padEnd(8)}${r.totalReturn}%`,
    );
  }

  // ── 對稱性檢查（long vs short 同 market 同 holdDays）──
  console.log();
  console.log('長短對稱性（同 market × 同 holdDays，long 與 short 累計報酬差）：');
  for (const market of MARKETS) {
    for (const holdDays of HOLD_DAYS) {
      const long = allResults.find(r => r.market === market && r.direction === 'long' && r.holdDays === holdDays);
      const short = allResults.find(r => r.market === market && r.direction === 'short' && r.holdDays === holdDays);
      if (!long || !short) continue;
      const diff = long.totalReturn - short.totalReturn;
      console.log(`  ${market} hold=${holdDays}: long=${long.totalReturn}% short=${short.totalReturn}% diff=${diff.toFixed(2)}%`);
    }
  }

  // ── 輸出 JSON ──
  const outDir = path.join(process.cwd(), 'data', 'backtest-results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `deviation-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    period: PERIOD,
    config: { TOP_N, POOL_N, HOLD_DAYS, MARKETS, DIRECTIONS },
    results: allResults,
  }, null, 2));
  console.log();
  console.log(`📄 結果寫入 ${outFile}`);
}

main().catch(err => {
  console.error('回測失敗:', err);
  process.exit(1);
});
