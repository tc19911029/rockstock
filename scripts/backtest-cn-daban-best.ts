/**
 * 陸股打板策略：全排序因子批量回測
 *
 * 自動跑所有組合找最佳打板排序因子
 *
 * 組合：8種排序因子 × 3種高開區間 = 24組
 *
 * Usage:
 *   cd /Users/tzu-chienhsu/Desktop/rockstock
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-cn-daban-best.ts
 */

import fs   from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

// ══════════════════════════════════════════════════════════════
// 全局設定
// ══════════════════════════════════════════════════════════════

const PERIOD   = { start: '2025-04-16', end: '2026-04-16' };
const CAPITAL  = 1_000_000;
const CN_COST  = 0.16;    // 手續費 %
const LIMIT_UP = 9.5;     // 漲停判斷門檻 %
const MIN_TO   = 5_000_000; // 昨日最低成交額

// S1 出場參數
const S1_SL      = -5;    // 固定止損 %
const S1_GATE    = 10;    // 啟動MA5保護門檻 %
const S1_MAXHOLD = 60;    // 最長持有天數

// ══════════════════════════════════════════════════════════════
// 組合定義
// ══════════════════════════════════════════════════════════════

type DabanSort =
  | '純成交額' | '封板力度' | '多因子' | '連板優先'
  | '量比優先' | '動能優先' | '高開幅度' | '封板+高開';

interface GapRange { min: number; max: number; label: string; }

const ALL_SORTS: DabanSort[] = [
  '純成交額', '封板力度', '多因子', '連板優先',
  '量比優先', '動能優先', '高開幅度', '封板+高開',
];

const ALL_GAPS: GapRange[] = [
  { min: 2, max: 8, label: '高開2~8%' },
  { min: 3, max: 8, label: '高開3~8%' },
  { min: 2, max: 6, label: '高開2~6%' },
];

// ══════════════════════════════════════════════════════════════
// 型別
// ══════════════════════════════════════════════════════════════

interface StockData {
  name:    string;
  candles: CandleWithIndicators[];
}

interface DabanFeatures {
  symbol: string; name: string; idx: number; candles: CandleWithIndicators[];
  entryPrice: number;
  gapUp: number; boards: number;
  yestTurnover: number; yestVR: number; seal: number; mom5: number;
  rankScore: number;
}

interface ExitResult {
  exitIdx: number; exitPrice: number; exitReason: string;
}

interface Trade {
  netPct: number; pnl: number; capitalAfter: number; holdDays: number;
}

interface ComboResult {
  sortBy:       DabanSort;
  gap:          GapRange;
  totalReturn:  number;
  tradeCount:   number;
  winRate:      number;
  maxDD:        number;
  avgHold:      number;
  finalCapital: number;
}

// ══════════════════════════════════════════════════════════════
// 排序因子
// ══════════════════════════════════════════════════════════════

const SORT_DEFS: Record<DabanSort, (f: DabanFeatures) => number> = {
  '純成交額':  f => Math.log10(Math.max(f.yestTurnover, 1)),
  '封板力度':  f => f.seal * 10 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '多因子':    f => f.seal * 2 + Math.min(f.yestVR, 5) / 5
                    + Math.max(0, f.mom5) / 20
                    + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '連板優先':  f => f.boards * 3 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '量比優先':  f => Math.min(f.yestVR, 5) * 2 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '動能優先':  f => Math.max(0, f.mom5) / 5 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '高開幅度':  f => f.gapUp * 2 + Math.log10(Math.max(f.yestTurnover, 1)) / 10,
  '封板+高開': f => f.seal * 3 + f.gapUp,
};

// ══════════════════════════════════════════════════════════════
// 資料載入
// ══════════════════════════════════════════════════════════════

function loadStocks(): Map<string, StockData> {
  const stocks = new Map<string, StockData>();

  const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');
  if (fs.existsSync(cacheFile)) {
    process.stdout.write('  讀取CN bulk cache...');
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    let n = 0;
    for (const [sym, d] of Object.entries(raw.stocks as Record<string, { name: string; candles: unknown[] }>)) {
      if (!d.candles || d.candles.length < 60 || d.name.includes('ST')) continue;
      try {
        stocks.set(sym, { name: d.name, candles: computeIndicators(d.candles as CandleWithIndicators[]) });
        n++;
      } catch { /* 略 */ }
    }
    console.log(` ${n} 支`);
  }

  const perDir = path.join(process.cwd(), 'data', 'candles', 'CN');
  if (fs.existsSync(perDir)) {
    process.stdout.write('  補充CN per-symbol...');
    let u = 0;
    for (const f of fs.readdirSync(perDir).filter(f => f.endsWith('.json'))) {
      const sym = f.replace('.json', '');
      try {
        const raw2 = JSON.parse(fs.readFileSync(path.join(perDir, f), 'utf-8'));
        const c2: CandleWithIndicators[] = Array.isArray(raw2) ? raw2 : raw2.candles ?? raw2;
        if (!c2 || c2.length < 60) continue;
        const existing = stocks.get(sym);
        const lastE = existing?.candles.at(-1)?.date?.slice(0, 10) ?? '';
        const lastN = c2.at(-1)?.date?.slice(0, 10) ?? '';
        if (lastN > lastE) {
          const nm = (raw2 as { name?: string }).name ?? existing?.name ?? sym;
          if (typeof nm === 'string' && nm.includes('ST')) continue;
          stocks.set(sym, { name: nm, candles: computeIndicators(c2) });
          u++;
        }
      } catch { /* 略 */ }
    }
    console.log(` 更新 ${u} 支，共 ${stocks.size} 支`);
  }

  return stocks;
}

// ══════════════════════════════════════════════════════════════
// 工具函式
// ══════════════════════════════════════════════════════════════

function dayGain(candles: CandleWithIndicators[], idx: number): number {
  if (idx <= 0) return 0;
  const p = candles[idx - 1].close;
  return p > 0 ? (candles[idx].close - p) / p * 100 : 0;
}

function consecutiveLimitUp(candles: CandleWithIndicators[], idx: number): number {
  let n = 0;
  for (let i = idx; i >= 1; i--) {
    if (dayGain(candles, i) >= LIMIT_UP) n++; else break;
  }
  return n;
}

// ══════════════════════════════════════════════════════════════
// 打板候選建立
// ══════════════════════════════════════════════════════════════

function buildCandidate(
  symbol: string, name: string,
  candles: CandleWithIndicators[], idx: number,
  sortFn: (f: DabanFeatures) => number,
  gap: GapRange,
): DabanFeatures | null {
  if (idx < 10 || idx + 3 >= candles.length) return null;

  const today = candles[idx];
  const yest  = candles[idx - 1];
  const db    = candles[idx - 2];

  // 昨日漲停
  const yestGain = db.close > 0 ? (yest.close - db.close) / db.close * 100 : 0;
  if (yestGain < LIMIT_UP) return null;

  // 昨天不能是一字板
  if (yest.open === yest.high && yest.high === yest.close) return null;

  const yestVol      = yest.volume ?? 0;
  const yestTurnover = yestVol * yest.close;
  if (yestTurnover < MIN_TO) return null;

  // 今日高開幅度
  const gapUp = yest.close > 0 ? (today.open - yest.close) / yest.close * 100 : 0;
  if (gapUp < gap.min || gapUp >= LIMIT_UP || gapUp > gap.max) return null;

  const boards      = consecutiveLimitUp(candles, idx - 1);
  const vols5       = Array.from({ length: 5 }, (_, i) => candles[idx - 1 - i]?.volume ?? 0);
  const avgVol5     = vols5.reduce((a, b) => a + b, 0) / vols5.length;
  const yestVR      = avgVol5 > 0 ? yestVol / avgVol5 : 1;
  const yRange      = yest.high - yest.low;
  const upperShadow = yest.high - Math.max(yest.open, yest.close);
  const seal        = yRange > 0 ? 1 - upperShadow / yRange : 1;
  const mom5        = idx >= 6 ? (yest.close / candles[idx - 6].close - 1) * 100 : 0;

  const f: DabanFeatures = {
    symbol, name, idx, candles,
    entryPrice: today.open,
    gapUp: +gapUp.toFixed(2),
    boards, yestTurnover, yestVR, seal, mom5, rankScore: 0,
  };
  f.rankScore = sortFn(f);
  return f;
}

// ══════════════════════════════════════════════════════════════
// S1 出場策略
// ══════════════════════════════════════════════════════════════

function exitS1(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
): ExitResult | null {
  let maxGain = 0;

  for (let d = 0; d <= S1_MAXHOLD; d++) {
    const fi = entryIdx + d;
    if (fi >= candles.length) break;
    const c    = candles[fi];
    const prev = fi > 0 ? candles[fi - 1] : null;

    const lowRet   = entryPrice > 0 ? (c.low   - entryPrice) / entryPrice * 100 : 0;
    const closeRet = entryPrice > 0 ? (c.close - entryPrice) / entryPrice * 100 : 0;
    if (closeRet > maxGain) maxGain = closeRet;

    if (d === 0) {
      if (closeRet <= S1_SL) return { exitIdx: fi, exitPrice: c.close, exitReason: `止損${S1_SL}%（進場日）` };
      continue;
    }

    // ① 固定止損
    if (lowRet <= S1_SL) {
      return { exitIdx: fi, exitPrice: +(entryPrice * (1 + S1_SL / 100)).toFixed(2), exitReason: `止損${S1_SL}%` };
    }

    // ② 漲超10%後跌破MA5
    if (maxGain >= S1_GATE && c.ma5 != null && c.close < c.ma5) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: '漲超10%後跌破MA5' };
    }

    // ③ 急漲後大量長黑K
    const vols5  = Array.from({ length: 5 }, (_, i) => candles[Math.max(0, fi - 1 - i)]?.volume ?? 0);
    const avgVol = vols5.reduce((a, b) => a + b, 0) / vols5.length;
    const volRatio = avgVol > 0 ? (c.volume ?? 0) / avgVol : 0;
    const body = Math.abs(c.close - c.open);
    if (fi >= 3) {
      const prev3Up     = [candles[fi-1], candles[fi-2], candles[fi-3]].every(x => x.close > x.open);
      const isLongBlack = c.close < c.open && body / c.open >= 0.02;
      if (prev3Up && isLongBlack && volRatio > 1.5) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '急漲後長黑K' };
      }
    }

    // ④ 強覆蓋
    if (prev && prev.close > prev.open && c.close < c.open) {
      const midPrice   = (prev.open + prev.close) / 2;
      const kdDownTurn = c.kdK != null && prev.kdK != null && c.kdK < prev.kdK;
      if (c.close < midPrice && kdDownTurn) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '強覆蓋' };
      }
    }

    // ⑤ 頭頭低
    if (fi >= 10) {
      const recentHighs: number[] = [];
      for (let i = fi - 1; i >= Math.max(1, fi - 20) && recentHighs.length < 2; i--) {
        const ci = candles[i], pi = candles[i-1], ni = candles[i+1];
        if (ci && pi && ni && ci.high > pi.high && ci.high > ni.high) recentHighs.push(ci.high);
      }
      if (recentHighs.length >= 2 && recentHighs[0] < recentHighs[1] && c.close < recentHighs[0]) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: '頭頭低' };
      }
    }

    // ⑥ KD高位死叉
    if (c.kdK != null && c.kdD != null && prev?.kdK != null && prev.kdD != null) {
      if (prev.kdK > 70 && prev.kdK >= prev.kdD && c.kdK < c.kdD) {
        return { exitIdx: fi, exitPrice: c.close, exitReason: 'KD高位死叉' };
      }
    }

    // ⑦ 安全網
    if (d === S1_MAXHOLD) {
      return { exitIdx: fi, exitPrice: c.close, exitReason: `持股${S1_MAXHOLD}天到期` };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// 單一組合回測
// ══════════════════════════════════════════════════════════════

function runCombo(
  sortBy: DabanSort,
  gap: GapRange,
  allStocks: Map<string, StockData>,
  tradingDays: string[],
): ComboResult {
  const sortFn = SORT_DEFS[sortBy];
  const trades: Trade[] = [];
  let capital = CAPITAL;
  let holdingUntilDayIdx = -1;

  // 市場冷度：CN打板要求至少15支昨日漲停
  const coldThreshold = 15;

  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    if (dayIdx <= holdingUntilDayIdx) continue;

    const date = tradingDays[dayIdx];

    // 市場冷度檢查
    let limitUpCount = 0;
    for (const [, sd] of allStocks) {
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 2) continue;
      if (dayGain(sd.candles, idx - 1) >= LIMIT_UP) limitUpCount++;
    }
    if (limitUpCount < coldThreshold) continue;

    // 建立候選
    const cands: DabanFeatures[] = [];
    for (const [symbol, sd] of allStocks) {
      const idx = sd.candles.findIndex(c => c.date?.slice(0, 10) === date);
      if (idx < 0) continue;
      const cand = buildCandidate(symbol, sd.name, sd.candles, idx, sortFn, gap);
      if (cand) cands.push(cand);
    }
    if (cands.length === 0) continue;

    cands.sort((a, b) => b.rankScore - a.rankScore);
    const picked = cands[0];

    // 打板用今日開盤進場（不需要+1天）
    const entryDayIdx = picked.idx;
    const exitResult  = exitS1(picked.candles, entryDayIdx, picked.entryPrice);
    if (!exitResult) continue;

    const { exitIdx, exitPrice } = exitResult;
    const exitDate    = picked.candles[exitIdx]?.date?.slice(0, 10) ?? '';
    const exitDayIdx  = tradingDays.indexOf(exitDate);

    const grossPct = (exitPrice - picked.entryPrice) / picked.entryPrice * 100;
    const netPct   = grossPct - CN_COST;
    const pnl      = capital * netPct / 100;
    capital        = Math.max(0, capital + pnl);

    trades.push({
      netPct:       +netPct.toFixed(3),
      pnl:          +pnl.toFixed(0),
      capitalAfter: +capital.toFixed(0),
      holdDays:     exitIdx - entryDayIdx,
    });

    holdingUntilDayIdx = exitDayIdx >= 0 ? exitDayIdx : dayIdx + (exitIdx - entryDayIdx);
  }

  const finalCapital = trades.at(-1)?.capitalAfter ?? CAPITAL;
  const totalReturn  = (finalCapital - CAPITAL) / CAPITAL * 100;
  const wins         = trades.filter(t => t.netPct > 0);
  const winRate      = trades.length > 0 ? wins.length / trades.length * 100 : 0;
  const avgHold      = trades.length > 0 ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length : 0;

  let peak = CAPITAL, maxDD = 0, cap = CAPITAL;
  for (const t of trades) {
    cap = t.capitalAfter;
    if (cap > peak) peak = cap;
    const dd = (peak - cap) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return { sortBy, gap, totalReturn, tradeCount: trades.length, winRate, maxDD, avgHold, finalCapital };
}

// ══════════════════════════════════════════════════════════════
// 主程式
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   陸股打板策略：全因子批量回測       ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log(`  週期：${PERIOD.start} ～ ${PERIOD.end}`);
  console.log(`  初始籌碼：${CAPITAL.toLocaleString()} 人民幣`);
  console.log(`  賣出策略：S1（止損-5% + 曾漲超10%後跌破MA5）`);
  console.log(`  組合數：${ALL_SORTS.length} 排序 × ${ALL_GAPS.length} 高開區間 = ${ALL_SORTS.length * ALL_GAPS.length} 組\n`);

  console.log('  載入CN資料...');
  const allStocks = loadStocks();

  const tradingDaySet = new Set<string>();
  for (const [, sd] of allStocks) {
    for (const c of sd.candles) {
      const d = c.date?.slice(0, 10);
      if (d && d >= PERIOD.start && d <= PERIOD.end) tradingDaySet.add(d);
    }
  }
  const tradingDays = [...tradingDaySet].sort();
  console.log(`  交易日：${tradingDays[0]} ～ ${tradingDays.at(-1)} 共 ${tradingDays.length} 天\n`);

  const results: ComboResult[] = [];
  let done = 0;
  const total = ALL_SORTS.length * ALL_GAPS.length;

  for (const gap of ALL_GAPS) {
    for (const sortBy of ALL_SORTS) {
      const result = runCombo(sortBy, gap, allStocks, tradingDays);
      results.push(result);
      done++;
      process.stdout.write(`  進度：${done}/${total}\r`);
    }
  }
  process.stdout.write('\n');

  // 排行榜
  results.sort((a, b) => b.totalReturn - a.totalReturn);

  console.log('\n' + '═'.repeat(80));
  console.log('  【陸股打板】排行榜（依總報酬排序）');
  console.log('═'.repeat(80));
  console.log(
    '  排名  ' +
    '總報酬  '.padEnd(9) +
    '勝率   '.padEnd(8) +
    '最大回撤  '.padEnd(11) +
    '交易  '.padEnd(7) +
    '均持天  '.padEnd(8) +
    '高開區間        排序因子'
  );
  console.log('─'.repeat(80));

  results.forEach((r, i) => {
    const ret = (r.totalReturn >= 0 ? '+' : '') + r.totalReturn.toFixed(1) + '%';
    const wr  = r.winRate.toFixed(0) + '%';
    const dd  = r.maxDD.toFixed(1) + '%';
    console.log(
      `  ${(i + 1).toString().padStart(3)}   ` +
      `${ret.padEnd(9)}${wr.padEnd(8)}${dd.padEnd(11)}` +
      `${r.tradeCount.toString().padEnd(7)}${r.avgHold.toFixed(1).padEnd(8)}` +
      `${r.gap.label.padEnd(16)}${r.sortBy}`
    );
  });

  const best = results[0];
  console.log('\n  ★ 冠軍組合：');
  console.log(`    排序因子：${best.sortBy}`);
  console.log(`    高開區間：${best.gap.label}`);
  console.log(`    總報酬：${(best.totalReturn >= 0 ? '+' : '') + best.totalReturn.toFixed(2)}%`);
  console.log(`    勝率：${best.winRate.toFixed(1)}%`);
  console.log(`    最大回撤：${best.maxDD.toFixed(1)}%`);
  console.log(`    交易筆數：${best.tradeCount}`);
  console.log(`    平均持股：${best.avgHold.toFixed(1)} 天`);
  console.log(`    最終資金：${best.finalCapital.toLocaleString()} 人民幣`);
  console.log('═'.repeat(80) + '\n');
}

main().catch(console.error);
