/**
 * A股打板因子分析
 *
 * 目標：找出漲停候選股中，哪些特徵能預測「買進後漲更多」
 * 方法：收集每天所有漲停股的 25+ 特徵 + forward return，做統計分析
 *
 * 分析輸出：
 * 1. Pearson/Spearman 相關性排行
 * 2. 五分位分析（Q1-Q5 各組平均報酬）
 * 3. Information Coefficient（每日 rank correlation 平均）
 * 4. 大漲 vs 大跌特徵比較
 * 5. 新排序公式建議 + 驗證回測（新 vs 舊 PnL）
 *
 * Usage: npx tsx scripts/backtest-cn-daban-factors.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

// ── 參數 ─────────────────────────────────────────────────────────────────────
const BACKTEST_START = '2024-01-01';
const BACKTEST_END   = '2026-04-04';
const LIMIT_UP_PCT   = 9.5;
const MIN_TURNOVER   = 5e6;
const GAP_UP_MIN     = 2.0;  // 高開門檻（回測用）
const TAKE_PROFIT    = 5;
const STOP_LOSS      = -3;
const MAX_HOLD_DAYS  = 2;
const ROUND_TRIP_COST = 0.16; // %

const INITIAL_CAPITAL = 1_000_000;

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');

// ── Types ────────────────────────────────────────────────────────────────────

interface DabanCandidate {
  date: string;
  symbol: string;
  name: string;
  idx: number;
  candles: CandleWithIndicators[];

  // 進場資訊
  entryPrice: number;     // 隔日開盤價
  gapUpPct: number;       // 高開幅度

  // ── 因子（25+）──
  // 基本
  turnover: number;
  volumeRatio: number;
  consecutiveBoards: number;
  price: number;

  // 漲停品質
  upperShadowRatio: number;  // 上影線/全幅（小=封得穩）
  bodyRatio: number;          // 實體/全幅
  sealStrength: number;       // close == high ? 1 : 0（收盤=漲停價=封得死）

  // 前期動能
  mom3d: number;
  mom5d: number;
  mom10d: number;
  atr5: number;

  // 均線位置
  priceVsMa5: number;
  priceVsMa10: number;
  priceVsMa20: number;
  priceVsMa60: number;
  distFrom20dHigh: number;
  distFrom60dHigh: number;

  // 技術指標
  rsi: number;
  kdK: number;
  macdHist: number;

  // 量能結構
  vol5vs20: number;

  // 市場環境
  marketLimitUpCount: number;
  marketYestAvgReturn: number;

  // ── Forward Return ──
  d1Return: number;    // 次日開盤買 → 次日收盤
  d2Return: number;    // → 第2天收盤
  d3Return: number;
  d5Return: number;
  tradeReturn: number; // 實際交易模擬報酬（含止盈止損）
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDayReturn(candles: CandleWithIndicators[], idx: number): number {
  if (idx <= 0) return 0;
  return (candles[idx].close - candles[idx - 1].close) / candles[idx - 1].close * 100;
}

function getConsecutiveLimitUp(candles: CandleWithIndicators[], idx: number): number {
  let count = 0;
  for (let i = idx; i >= 1; i--) {
    if (getDayReturn(candles, i) >= LIMIT_UP_PCT) count++;
    else break;
  }
  return count;
}

function getAvgVolume(candles: CandleWithIndicators[], idx: number, period: number): number {
  let sum = 0;
  const start = Math.max(0, idx - period + 1);
  for (let i = start; i <= idx; i++) sum += (candles[i].volume ?? 0);
  return sum / (idx - start + 1);
}

function getMA(candles: CandleWithIndicators[], idx: number, period: number): number {
  let sum = 0;
  const start = Math.max(0, idx - period + 1);
  for (let i = start; i <= idx; i++) sum += candles[i].close;
  return sum / (idx - start + 1);
}

function getHighest(candles: CandleWithIndicators[], idx: number, period: number): number {
  let max = -Infinity;
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++) {
    if (candles[i].high > max) max = candles[i].high;
  }
  return max;
}

function getATR(candles: CandleWithIndicators[], idx: number, period: number): number {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, idx - period + 1); i <= idx; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    sum += tr / candles[i].close * 100;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function simulateTradeReturn(candles: CandleWithIndicators[], entryIdx: number, entryPrice: number): number {
  for (let d = 1; d <= MAX_HOLD_DAYS; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) break;
    const c = candles[fi];
    const highRet = (c.high - entryPrice) / entryPrice * 100;
    const lowRet = (c.low - entryPrice) / entryPrice * 100;

    if (highRet >= TAKE_PROFIT) return TAKE_PROFIT - ROUND_TRIP_COST;
    if (lowRet <= STOP_LOSS) return STOP_LOSS - ROUND_TRIP_COST;

    if (d === MAX_HOLD_DAYS) {
      return (c.close - entryPrice) / entryPrice * 100 - ROUND_TRIP_COST;
    }

    if (d === 1 && c.close < c.open) {
      const ni = fi + 1;
      if (ni < candles.length) {
        return (candles[ni].open - entryPrice) / entryPrice * 100 - ROUND_TRIP_COST;
      }
    }
  }
  return 0;
}

// ── Statistics ───────────────────────────────────────────────────────────────

function pearsonCorr(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : 0;
}

function spearmanCorr(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const rank = (arr: number[]) => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    for (let i = 0; i < n; i++) ranks[sorted[i].i] = i + 1;
    return ranks;
  };
  return pearsonCorr(rank(xs), rank(ys));
}

function quintileAnalysis(xs: number[], ys: number[]): number[] {
  const pairs = xs.map((x, i) => ({ x, y: ys[i] })).sort((a, b) => a.x - b.x);
  const n = pairs.length;
  const qSize = Math.floor(n / 5);
  const result: number[] = [];
  for (let q = 0; q < 5; q++) {
    const start = q * qSize;
    const end = q === 4 ? n : (q + 1) * qSize;
    const slice = pairs.slice(start, end);
    const avg = slice.reduce((s, p) => s + p.y, 0) / slice.length;
    result.push(avg);
  }
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  A股打板因子分析');
  console.log(`  期間：${BACKTEST_START} ~ ${BACKTEST_END}`);
  console.log('  目標：找出預測買進後漲更多的因子');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 載入資料
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const allStocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: unknown[] }>)) {
    if (!data.candles || data.candles.length < 60) continue;
    if (data.name.includes('ST')) continue;
    try {
      allStocks.set(sym, { name: data.name, candles: computeIndicators(data.candles as CandleWithIndicators[]) });
    } catch { /* skip */ }
  }
  console.log(`  載入 ${allStocks.size} 支股票`);

  // 取得交易日
  const benchStock = allStocks.get('000001.SZ') ?? allStocks.get('601318.SS');
  if (!benchStock) { console.error('找不到基準股'); return; }
  const tradingDays = benchStock.candles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);
  console.log(`  ${tradingDays.length} 個交易日\n`);

  // ── Phase 1: 收集所有漲停候選股的因子 + forward return ──

  const candidates: DabanCandidate[] = [];
  let dayCount = 0;

  for (const date of tradingDays) {
    dayCount++;
    if (dayCount % 50 === 0) console.log(`  進度：${dayCount}/${tradingDays.length}`);

    // 先算當日市場情緒
    let marketLimitUpCount = 0;
    let yesterdayLimitUpCount = 0;
    let yesterdayReturnSum = 0;

    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 2) continue;
      const todayReturn = getDayReturn(candles, idx);
      const yesterdayReturn = getDayReturn(candles, idx - 1);
      if (todayReturn >= LIMIT_UP_PCT) marketLimitUpCount++;
      if (yesterdayReturn >= LIMIT_UP_PCT) {
        yesterdayLimitUpCount++;
        yesterdayReturnSum += todayReturn;
      }
    }
    const marketYestAvgReturn = yesterdayLimitUpCount > 0 ? yesterdayReturnSum / yesterdayLimitUpCount : 0;

    // 掃描漲停候選股
    for (const [symbol, stockData] of allStocks) {
      const candles = stockData.candles;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 60 || idx >= candles.length - 10) continue;

      const today = candles[idx];
      const yesterday = candles[idx - 1];
      const dayBefore = candles[idx - 2];

      // 昨日漲停？
      const prevDayGain = (yesterday.close - dayBefore.close) / dayBefore.close * 100;
      if (prevDayGain < LIMIT_UP_PCT) continue;

      // 今日高開？
      const gapUpPct = (today.open - yesterday.close) / yesterday.close * 100;
      if (gapUpPct < 0) continue; // 收集所有高開的（含 <2%），之後分析用

      // 成交額
      const vol = today.volume ?? 0;
      const turnover = vol * today.close;
      if (turnover < MIN_TURNOVER) continue;

      // 不買一字板
      if (today.open === today.high && today.high === today.close) continue;

      // 不買開高走低收黑
      if (today.close < yesterday.close) continue;

      // 連板天數
      const consecutiveBoards = getConsecutiveLimitUp(candles, idx - 1);

      // Forward return（以今天開盤為進場價）
      const entryPrice = today.open;
      const d1Close = idx + 1 < candles.length ? candles[idx + 1].close : today.close;
      const d2Close = idx + 2 < candles.length ? candles[idx + 2].close : today.close;
      const d3Close = idx + 3 < candles.length ? candles[idx + 3].close : today.close;
      const d5Close = idx + 5 < candles.length ? candles[idx + 5].close : today.close;

      // 技術指標
      const totalRange = today.high - today.low;
      const upperShadow = totalRange > 0 ? (today.high - Math.max(today.open, today.close)) / totalRange : 0;
      const bodyRatio = totalRange > 0 ? Math.abs(today.close - today.open) / totalRange : 0;

      const ma5 = getMA(candles, idx, 5);
      const ma10 = getMA(candles, idx, 10);
      const ma20 = getMA(candles, idx, 20);
      const ma60 = getMA(candles, idx, 60);
      const avgVol5 = getAvgVolume(candles, idx, 5);
      const avgVol20 = getAvgVolume(candles, idx, 20);

      const indicators = candles[idx].indicators ?? ({} as Record<string, unknown>);
      const rsiVal = (indicators as { rsi?: number }).rsi ?? 50;
      const kdVal = (indicators as { kd?: { k: number; d: number } }).kd;
      const macdVal = (indicators as { macd?: { histogram: number } }).macd;

      candidates.push({
        date, symbol, name: stockData.name, idx, candles,
        entryPrice,
        gapUpPct: +gapUpPct.toFixed(2),

        // 因子
        turnover: Math.round(turnover),
        volumeRatio: +(avgVol5 > 0 ? vol / avgVol5 : 1).toFixed(2),
        consecutiveBoards,
        price: today.close,

        upperShadowRatio: +upperShadow.toFixed(3),
        bodyRatio: +bodyRatio.toFixed(3),
        sealStrength: today.close >= today.high * 0.999 ? 1 : 0,

        mom3d: +((today.close / candles[idx - 3].close - 1) * 100).toFixed(2),
        mom5d: +((today.close / candles[idx - 5].close - 1) * 100).toFixed(2),
        mom10d: +((today.close / candles[idx - 10].close - 1) * 100).toFixed(2),
        atr5: +getATR(candles, idx, 5).toFixed(2),

        priceVsMa5: +((today.close / ma5 - 1) * 100).toFixed(2),
        priceVsMa10: +((today.close / ma10 - 1) * 100).toFixed(2),
        priceVsMa20: +((today.close / ma20 - 1) * 100).toFixed(2),
        priceVsMa60: +((today.close / ma60 - 1) * 100).toFixed(2),
        distFrom20dHigh: +((today.close / getHighest(candles, idx, 20) - 1) * 100).toFixed(2),
        distFrom60dHigh: +((today.close / getHighest(candles, idx, 60) - 1) * 100).toFixed(2),

        rsi: +(rsiVal as number).toFixed(1),
        kdK: +(kdVal?.k ?? 50).toFixed(1),
        macdHist: +(macdVal?.histogram ?? 0).toFixed(3),

        vol5vs20: +(avgVol20 > 0 ? avgVol5 / avgVol20 : 1).toFixed(2),

        marketLimitUpCount,
        marketYestAvgReturn: +marketYestAvgReturn.toFixed(2),

        // Forward return
        d1Return: +((d1Close - entryPrice) / entryPrice * 100).toFixed(2),
        d2Return: +((d2Close - entryPrice) / entryPrice * 100).toFixed(2),
        d3Return: +((d3Close - entryPrice) / entryPrice * 100).toFixed(2),
        d5Return: +((d5Close - entryPrice) / entryPrice * 100).toFixed(2),
        tradeReturn: +simulateTradeReturn(candles, idx, entryPrice).toFixed(2),
      });
    }
  }

  console.log(`\n  共收集 ${candidates.length} 筆漲停候選股資料\n`);

  // 只分析高開 >= 2% 的（實際可交易的）
  const tradable = candidates.filter(c => c.gapUpPct >= GAP_UP_MIN);
  console.log(`  高開≥${GAP_UP_MIN}% 可交易候選股：${tradable.length} 筆`);

  // ── Phase 2: 因子相關性分析 ──

  const factorKeys: { key: keyof DabanCandidate; label: string }[] = [
    { key: 'turnover', label: '成交額' },
    { key: 'volumeRatio', label: '量比(日/5日)' },
    { key: 'consecutiveBoards', label: '連板天數' },
    { key: 'price', label: '股價' },
    { key: 'upperShadowRatio', label: '上影線比' },
    { key: 'bodyRatio', label: '實體比' },
    { key: 'sealStrength', label: '封板力度' },
    { key: 'mom3d', label: '3日動能' },
    { key: 'mom5d', label: '5日動能' },
    { key: 'mom10d', label: '10日動能' },
    { key: 'atr5', label: 'ATR5(%)' },
    { key: 'priceVsMa5', label: '價/MA5(%)' },
    { key: 'priceVsMa10', label: '價/MA10(%)' },
    { key: 'priceVsMa20', label: '價/MA20(%)' },
    { key: 'priceVsMa60', label: '價/MA60(%)' },
    { key: 'distFrom20dHigh', label: '離20日高(%)' },
    { key: 'distFrom60dHigh', label: '離60日高(%)' },
    { key: 'rsi', label: 'RSI' },
    { key: 'kdK', label: 'KD-K' },
    { key: 'macdHist', label: 'MACD柱' },
    { key: 'vol5vs20', label: '量能趨勢(5/20)' },
    { key: 'gapUpPct', label: '高開幅度' },
    { key: 'marketLimitUpCount', label: '市場漲停家數' },
    { key: 'marketYestAvgReturn', label: '昨漲停今均報酬' },
  ];

  const returnKeys: { key: keyof DabanCandidate; label: string }[] = [
    { key: 'tradeReturn', label: '交易報酬' },
    { key: 'd1Return', label: 'D1報酬' },
    { key: 'd5Return', label: 'D5報酬' },
  ];

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  因子相關性排行（Pearson / Spearman vs 交易報酬）');
  console.log('═══════════════════════════════════════════════════════════\n');

  const corrResults: { label: string; pearson: number; spearman: number; pearsonD5: number; ic: number }[] = [];

  for (const factor of factorKeys) {
    const xs = tradable.map(c => c[factor.key] as number);
    const ysTradeRet = tradable.map(c => c.tradeReturn);
    const ysD5 = tradable.map(c => c.d5Return);

    const p = pearsonCorr(xs, ysTradeRet);
    const s = spearmanCorr(xs, ysTradeRet);
    const pD5 = pearsonCorr(xs, ysD5);

    // IC: 每天的 rank correlation 平均
    const dailyDates = [...new Set(tradable.map(c => c.date))];
    let icSum = 0, icCount = 0;
    for (const d of dailyDates) {
      const dayC = tradable.filter(c => c.date === d);
      if (dayC.length < 3) continue;
      const dxs = dayC.map(c => c[factor.key] as number);
      const dys = dayC.map(c => c.tradeReturn);
      icSum += spearmanCorr(dxs, dys);
      icCount++;
    }
    const ic = icCount > 0 ? icSum / icCount : 0;

    corrResults.push({ label: factor.label, pearson: p, spearman: s, pearsonD5: pD5, ic });
  }

  // 按 |IC| 排序
  corrResults.sort((a, b) => Math.abs(b.ic) - Math.abs(a.ic));

  console.log('因子'.padEnd(18) + 'Pearson(交易)'.padStart(14) + 'Spearman(交易)'.padStart(15) + 'Pearson(D5)'.padStart(13) + 'IC均值'.padStart(10));
  console.log('─'.repeat(72));
  for (const r of corrResults) {
    const fmt = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(4);
    console.log(
      r.label.padEnd(18) +
      fmt(r.pearson).padStart(14) +
      fmt(r.spearman).padStart(15) +
      fmt(r.pearsonD5).padStart(13) +
      fmt(r.ic).padStart(10)
    );
  }

  // ── Phase 3: 五分位分析（Top 5 因子）──

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  五分位分析（Top 8 因子，Q1=最低，Q5=最高）');
  console.log('═══════════════════════════════════════════════════════════\n');

  const topFactors = corrResults.slice(0, 8);
  for (const factor of topFactors) {
    const fk = factorKeys.find(f => f.label === factor.label)!;
    const xs = tradable.map(c => c[fk.key] as number);
    const ys = tradable.map(c => c.tradeReturn);
    const quintiles = quintileAnalysis(xs, ys);

    const isMonotonic = quintiles[4] > quintiles[0];
    const spread = quintiles[4] - quintiles[0];

    console.log(`  ${factor.label}（IC=${factor.ic >= 0 ? '+' : ''}${factor.ic.toFixed(4)}）`);
    console.log(
      '    Q1(低)  '.padEnd(10) + quintiles.map((q, i) =>
        `Q${i + 1}: ${(q >= 0 ? '+' : '')}${q.toFixed(2)}%`
      ).join('  ') +
      `  spread=${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%` +
      (isMonotonic ? ' ✅' : ' ⚠️')
    );
    console.log('');
  }

  // ── Phase 4: 大漲 vs 大跌特徵比較 ──

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  大漲 vs 大跌 vs 普通 特徵比較（交易報酬分組）');
  console.log('═══════════════════════════════════════════════════════════\n');

  const winners = tradable.filter(c => c.tradeReturn > 3);
  const normal = tradable.filter(c => c.tradeReturn >= -1 && c.tradeReturn <= 1);
  const losers = tradable.filter(c => c.tradeReturn < -2);

  console.log(`  大漲(>3%): ${winners.length}筆  普通(-1%~1%): ${normal.length}筆  大跌(<-2%): ${losers.length}筆\n`);

  function groupAvg(group: DabanCandidate[], key: keyof DabanCandidate): string {
    const vals = group.map(f => f[key]).filter((v): v is number => typeof v === 'number' && !isNaN(v));
    if (vals.length === 0) return 'N/A';
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    return (avg >= 0 ? '+' : '') + avg.toFixed(2);
  }

  console.log('因子'.padEnd(18) + '大漲(>3%)'.padStart(12) + '普通(-1~1%)'.padStart(12) + '大跌(<-2%)'.padStart(12) + '  差異方向');
  console.log('─'.repeat(70));

  for (const factor of factorKeys) {
    const w = groupAvg(winners, factor.key);
    const n = groupAvg(normal, factor.key);
    const l = groupAvg(losers, factor.key);
    const wNum = parseFloat(w) || 0;
    const lNum = parseFloat(l) || 0;
    const diff = Math.abs(wNum - lNum) > 0.01
      ? (wNum > lNum ? '  ↑ 大漲較高' : '  ↓ 大漲較低')
      : '';
    console.log(factor.label.padEnd(18) + w.padStart(12) + n.padStart(12) + l.padStart(12) + diff);
  }

  // ── Phase 5: 新排序公式建議 + 回測比較 ──

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  排序公式回測比較（一次只買第1名）');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 定義排序公式
  interface RankFormula {
    name: string;
    fn: (c: DabanCandidate) => number;
    filter?: (c: DabanCandidate) => boolean;
  }

  const formulas: RankFormula[] = [
    // 基線
    {
      name: '基線：boardBonus×log(turnover)',
      fn: (c) => {
        const bb = c.consecutiveBoards === 1 ? 2.0 : c.consecutiveBoards === 2 ? 1.5 : 1.0;
        return bb * Math.log10(Math.max(c.turnover, 1));
      },
    },
    // 純成交額
    {
      name: '純成交額(log)',
      fn: (c) => Math.log10(Math.max(c.turnover, 1)),
    },
    // 封板力度 × 成交額
    {
      name: '封板力度×成交額',
      fn: (c) => (1 - c.upperShadowRatio) * Math.log10(Math.max(c.turnover, 1)),
    },
    // 量比 × 成交額
    {
      name: '量比×成交額',
      fn: (c) => Math.min(c.volumeRatio, 5) * Math.log10(Math.max(c.turnover, 1)),
    },
    // 低股價 + 成交額
    {
      name: '低價加權×成交額',
      fn: (c) => {
        const priceBonus = c.price < 15 ? 1.5 : c.price < 30 ? 1.2 : 1.0;
        return priceBonus * Math.log10(Math.max(c.turnover, 1));
      },
    },
    // 動能 + 成交額
    {
      name: '5日動能×成交額',
      fn: (c) => {
        const momBonus = c.mom5d > 15 ? 1.5 : c.mom5d > 10 ? 1.2 : 1.0;
        return momBonus * Math.log10(Math.max(c.turnover, 1));
      },
    },
    // 距20日高點近 + 成交額
    {
      name: '近新高×成交額',
      fn: (c) => {
        const nearHigh = c.distFrom20dHigh > -3 ? 1.5 : c.distFrom20dHigh > -10 ? 1.2 : 1.0;
        return nearHigh * Math.log10(Math.max(c.turnover, 1));
      },
    },
    // 離MA60遠=低位起漲
    {
      name: 'MA60偏低×成交額',
      fn: (c) => {
        const lowPos = c.priceVsMa60 < 5 ? 1.5 : c.priceVsMa60 < 15 ? 1.2 : 1.0;
        return lowPos * Math.log10(Math.max(c.turnover, 1));
      },
    },
    // 市場情緒好 + 成交額
    {
      name: '市場情緒×成交額',
      fn: (c) => {
        const sentBonus = c.marketYestAvgReturn > 2 ? 1.5 : c.marketYestAvgReturn > 0 ? 1.2 : 0.8;
        return sentBonus * Math.log10(Math.max(c.turnover, 1));
      },
    },
    // 多因子組合（根據相關性結果）
    {
      name: '多因子(封板+量比+動能+成交額)',
      fn: (c) => {
        const seal = (1 - c.upperShadowRatio) * 2;
        const volR = Math.min(c.volumeRatio, 5) / 5;
        const mom = Math.max(0, c.mom5d) / 20;
        const to = Math.log10(Math.max(c.turnover, 1)) / 10;
        return seal + volR + mom + to;
      },
    },
    // 反向：成交額最小
    {
      name: '反向：成交額最小',
      fn: (c) => -Math.log10(Math.max(c.turnover, 1)),
    },
    // 只買首板
    {
      name: '只買首板+成交額',
      fn: (c) => Math.log10(Math.max(c.turnover, 1)),
      filter: (c) => c.consecutiveBoards === 1,
    },
    // 首板 + 封板穩
    {
      name: '首板+封板穩+成交額',
      fn: (c) => (1 - c.upperShadowRatio) * Math.log10(Math.max(c.turnover, 1)),
      filter: (c) => c.consecutiveBoards === 1,
    },
    // 高開幅度排序
    {
      name: '高開幅度排序',
      fn: (c) => c.gapUpPct,
    },
    // 反向：高開最小（低高開）
    {
      name: '低高開排序(最小高開優先)',
      fn: (c) => -c.gapUpPct,
    },
    // ATR低（低波動）
    {
      name: '低波動(ATR小)×成交額',
      fn: (c) => (1 / Math.max(c.atr5, 0.5)) * Math.log10(Math.max(c.turnover, 1)),
    },
    // 冰點跳過策略
    {
      name: '基線+冰點跳過',
      fn: (c) => {
        const bb = c.consecutiveBoards === 1 ? 2.0 : c.consecutiveBoards === 2 ? 1.5 : 1.0;
        return bb * Math.log10(Math.max(c.turnover, 1));
      },
      filter: (c) => c.marketLimitUpCount >= 15 && c.marketYestAvgReturn > -3,
    },
  ];

  // 回測每個公式
  interface FormulaResult {
    name: string;
    trades: number;
    wins: number;
    winRate: number;
    avgReturn: number;
    totalReturn: number;
    capital: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
  }

  const formulaResults: FormulaResult[] = [];

  for (const formula of formulas) {
    // 按天分組
    const dayMap = new Map<string, DabanCandidate[]>();
    for (const c of tradable) {
      if (formula.filter && !formula.filter(c)) continue;
      if (!dayMap.has(c.date)) dayMap.set(c.date, []);
      dayMap.get(c.date)!.push(c);
    }

    // 每天買第1名
    const trades: { date: string; ret: number }[] = [];
    let holdingUntilDayIdx = -1;
    let capital = INITIAL_CAPITAL;

    for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
      if (dayIdx <= holdingUntilDayIdx) continue;
      const date = tradingDays[dayIdx];
      const dayCandidates = dayMap.get(date);
      if (!dayCandidates || dayCandidates.length === 0) continue;

      // 只保留 gapUp >= 2%
      const filtered = dayCandidates.filter(c => c.gapUpPct >= GAP_UP_MIN);
      if (filtered.length === 0) continue;

      // 排序
      filtered.sort((a, b) => formula.fn(b) - formula.fn(a));
      const pick = filtered[0];

      // 用預先算好的 tradeReturn
      const ret = pick.tradeReturn;
      capital += Math.round(capital * ret / 100);
      trades.push({ date, ret });

      // 持有期跳過
      holdingUntilDayIdx = dayIdx + MAX_HOLD_DAYS;
    }

    const wins = trades.filter(t => t.ret > 0);
    const losses = trades.filter(t => t.ret <= 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.ret, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.ret, 0) / losses.length : 0;
    const totalWin = wins.reduce((s, t) => s + t.ret, 0);
    const totalLoss = Math.abs(losses.reduce((s, t) => s + t.ret, 0));

    formulaResults.push({
      name: formula.name,
      trades: trades.length,
      wins: wins.length,
      winRate: trades.length > 0 ? wins.length / trades.length * 100 : 0,
      avgReturn: trades.length > 0 ? trades.reduce((s, t) => s + t.ret, 0) / trades.length : 0,
      totalReturn: (capital / INITIAL_CAPITAL - 1) * 100,
      capital,
      avgWin,
      avgLoss,
      profitFactor: totalLoss > 0 ? totalWin / totalLoss : 0,
    });
  }

  // 按總報酬排序
  formulaResults.sort((a, b) => b.totalReturn - a.totalReturn);

  console.log('排序公式'.padEnd(36) + '筆數'.padStart(5) + ' 勝率'.padStart(7) + '  均報酬'.padStart(8) + '  總報酬'.padStart(9) + '  最終資金'.padStart(13) + ' 均勝'.padStart(7) + '  均負'.padStart(7) + '  盈虧比'.padStart(7));
  console.log('─'.repeat(110));

  for (const r of formulaResults) {
    const isBaseline = r.name.startsWith('基線：');
    console.log(
      r.name.padEnd(36) +
      r.trades.toString().padStart(5) + ' ' +
      (r.winRate.toFixed(1) + '%').padStart(7) + '  ' +
      ((r.avgReturn >= 0 ? '+' : '') + r.avgReturn.toFixed(2) + '%').padStart(8) + '  ' +
      ((r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(1) + '%').padStart(9) + '  ' +
      r.capital.toLocaleString().padStart(13) + ' ' +
      ('+' + r.avgWin.toFixed(2) + '%').padStart(7) + '  ' +
      (r.avgLoss.toFixed(2) + '%').padStart(7) + '  ' +
      r.profitFactor.toFixed(2).padStart(7) +
      (isBaseline ? ' ◀ 現行' : '')
    );
  }
  console.log('─'.repeat(110));

  // ── Phase 6: 按日期統計（每天候選股數量分佈）──

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  每日候選股數量分佈');
  console.log('═══════════════════════════════════════════════════════════\n');

  const dailyCountMap = new Map<string, number>();
  for (const c of tradable) {
    dailyCountMap.set(c.date, (dailyCountMap.get(c.date) ?? 0) + 1);
  }
  const counts = [...dailyCountMap.values()];
  const daysWithCandidates = counts.length;
  const avgCount = counts.reduce((s, c) => s + c, 0) / daysWithCandidates;
  const maxCount = Math.max(...counts);
  const minCount = Math.min(...counts);
  const zeroCount = tradingDays.length - daysWithCandidates;

  console.log(`  交易日: ${tradingDays.length}`);
  console.log(`  有候選股的天數: ${daysWithCandidates} (${(daysWithCandidates / tradingDays.length * 100).toFixed(1)}%)`);
  console.log(`  無候選股的天數: ${zeroCount}`);
  console.log(`  每天平均候選股: ${avgCount.toFixed(1)} 支`);
  console.log(`  最多: ${maxCount} 支  最少: ${minCount} 支`);

  // 分佈
  const buckets = [1, 2, 3, 5, 10, 20, 50, 100];
  console.log('\n  候選股數量分佈:');
  for (let i = 0; i < buckets.length; i++) {
    const lo = i === 0 ? 1 : buckets[i - 1] + 1;
    const hi = buckets[i];
    const count = counts.filter(c => c >= lo && c <= hi).length;
    if (count > 0) {
      console.log(`    ${lo}-${hi}支: ${count}天 (${(count / daysWithCandidates * 100).toFixed(1)}%)`);
    }
  }
  const over100 = counts.filter(c => c > 100).length;
  if (over100 > 0) console.log(`    >100支: ${over100}天`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  分析完成');
  console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
