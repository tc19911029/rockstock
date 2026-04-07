/**
 * 回測：3因子排序（MTF + 共振 + 高勝率）→ 每天前3檔 → 後續5天漲幅
 *
 * 篩選：五條件（isCoreReady）
 * 排序：MTF分數 × W1 + 共振分數 × W2 + 高勝率分數 × W3
 * 每天選前3檔，統計 1D~5D 平均報酬
 *
 * Usage:
 *   npx tsx scripts/backtest-3factor-top3.ts              # 台股
 *   npx tsx scripts/backtest-3factor-top3.ts --market CN  # 陸股
 */
import fs from 'fs';
import path from 'path';
import { computeIndicators } from '../lib/indicators';
import { evaluateSixConditions } from '../lib/analysis/trendAnalysis';
import { evaluateMultiTimeframe } from '../lib/analysis/multiTimeframeFilter';
import { evaluateHighWinRateEntry } from '../lib/analysis/highWinRateEntry';
import { checkLongProhibitions } from '../lib/rules/entryProhibitions';
import { evaluateElimination } from '../lib/scanner/eliminationFilter';
import { ruleEngine } from '../lib/rules/ruleEngine';
import { ZHU_V1 } from '../lib/strategy/StrategyConfig';
import type { CandleWithIndicators, Candle } from '../types';

const thresholds = ZHU_V1.thresholds;

const BACKTEST_START = '2024-04-01';
const BACKTEST_END   = '2026-04-04';
const FORWARD_DAYS   = [1, 2, 3, 4, 5];
const TOP_N          = 3;
const STRICT6        = process.argv.includes('--strict6');

// ── 權重組合（MTF, 共振, 高勝率）──────────────────────────────────────────
const COMBOS = [
  // 單因子
  { name: '純共振',           wM: 0,   wR: 1,   wH: 0   },
  { name: '純高勝',           wM: 0,   wR: 0,   wH: 1   },
  { name: '純MTF',            wM: 1,   wR: 0,   wH: 0   },
  // 雙因子
  { name: '共振70+高勝30',    wM: 0,   wR: 0.7, wH: 0.3 },
  { name: '共振50+高勝50',    wM: 0,   wR: 0.5, wH: 0.5 },
  { name: '共振30+高勝70',    wM: 0,   wR: 0.3, wH: 0.7 },
  { name: 'MTF50+共振50',     wM: 0.5, wR: 0.5, wH: 0   },
  { name: 'MTF50+高勝50',     wM: 0.5, wR: 0,   wH: 0.5 },
  // 三因子
  { name: '等權33:33:33',     wM: 0.33, wR: 0.34, wH: 0.33 },
  { name: 'M20+R50+H30',     wM: 0.2, wR: 0.5, wH: 0.3 },
  { name: 'M20+R30+H50',     wM: 0.2, wR: 0.3, wH: 0.5 },
  { name: 'M30+R50+H20',     wM: 0.3, wR: 0.5, wH: 0.2 },
  { name: 'M10+R60+H30',     wM: 0.1, wR: 0.6, wH: 0.3 },
  { name: 'M10+R30+H60',     wM: 0.1, wR: 0.3, wH: 0.6 },
  // 反向 MTF（MTF 低分反而好）
  { name: '反MTF50+共振50',   wM: -0.5, wR: 0.5, wH: 0  },
  { name: '反MTF30+共振40+高勝30', wM: -0.3, wR: 0.4, wH: 0.3 },
  { name: '反MTF20+共振50+高勝30', wM: -0.2, wR: 0.5, wH: 0.3 },
];

// ── Parse args ───────────────────────────────────────────────────────────────
const marketIdx = process.argv.indexOf('--market');
const market = marketIdx >= 0 ? (process.argv[marketIdx + 1] ?? 'TW') : 'TW';
const label = market === 'CN' ? '陸股' : '台股';

const cacheFile = path.join(process.cwd(), 'data',
  market === 'CN' ? 'backtest-candles-cn.json' : 'backtest-candles.json');

const benchmarks = market === 'CN'
  ? ['600519.SS', '601318.SS', '000001.SZ']
  : ['2330.TW', '2317.TW', '2454.TW'];

interface CacheData {
  savedAt: string;
  stocks: Record<string, { name: string; candles: Candle[] }>;
}

interface Candidate {
  symbol: string;
  name: string;
  candleIdx: number;
  candles: CandleWithIndicators[];
  mtfScore: number;
  resonanceScore: number;
  highWinRateScore: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function findDateIndex(candles: CandleWithIndicators[], targetDate: string): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    const d = candles[i].date?.slice(0, 10);
    if (d && d <= targetDate) return i;
  }
  return -1;
}

function forwardReturn(candles: CandleWithIndicators[], idx: number, days: number): number | null {
  const exit = idx + days;
  if (exit >= candles.length) return null;
  const entry = candles[idx].close;
  if (!entry || entry <= 0) return null;
  return +((candles[exit].close - entry) / entry * 100).toFixed(2);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const filterLabel = STRICT6 ? '6條件全過' : '5條件(isCoreReady)';
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  回測：3因子排序 → 每天前${TOP_N}檔（${label}）`);
  console.log(`  篩選：${filterLabel} + KD + 上影線 + 戒律 + 淘汰法`);
  console.log(`  期間：${BACKTEST_START} ~ ${BACKTEST_END}`);
  console.log(`  組合數：${COMBOS.length}`);
  console.log(`═══════════════════════════════════════════════════\n`);

  if (!fs.existsSync(cacheFile)) {
    console.error(`❌ 找不到快取 ${cacheFile}`);
    return;
  }

  const raw: CacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  console.log(`📦 載入快取（${raw.savedAt}）`);

  const allCandles = new Map<string, { candles: CandleWithIndicators[]; name: string }>();
  for (const [symbol, data] of Object.entries(raw.stocks)) {
    if (data.candles.length >= 60) {
      allCandles.set(symbol, { candles: computeIndicators(data.candles), name: data.name });
    }
  }
  console.log(`   ${allCandles.size} 支股票\n`);

  // 取交易日
  let benchCandles: CandleWithIndicators[] | undefined;
  for (const s of benchmarks) {
    benchCandles = allCandles.get(s)?.candles;
    if (benchCandles && benchCandles.length > 100) break;
  }
  if (!benchCandles) { console.error('❌ 找不到基準股'); return; }

  const tradingDays = benchCandles
    .map(c => c.date?.slice(0, 10))
    .filter((d): d is string => !!d && d >= BACKTEST_START && d <= BACKTEST_END);

  console.log(`📅 回測期間共 ${tradingDays.length} 個交易日\n`);

  // 每個 combo 的統計
  const comboStats = COMBOS.map(() => ({
    returns: FORWARD_DAYS.map(() => [] as number[]),
    pickCount: 0,
    noCandidateDays: 0,
    dailyPicks: [] as { date: string; symbol: string; name: string; ret1d: number | null }[],
  }));

  let dayCount = 0;
  for (const date of tradingDays) {
    dayCount++;
    if (dayCount % 20 === 0) {
      console.log(`   處理進度：${dayCount}/${tradingDays.length} 天`);
    }

    // Step 1: 找通過五條件的候選股
    const candidates: Candidate[] = [];

    for (const [symbol, data] of allCandles) {
      const idx = findDateIndex(data.candles, date);
      if (idx < 60) continue;
      if (data.candles[idx].date?.slice(0, 10) !== date) continue;

      // 條件篩選
      const sixConds = evaluateSixConditions(data.candles, idx, thresholds);
      if (STRICT6) {
        if (sixConds.totalScore < 6) continue; // 6條件全過
      } else {
        if (!sixConds.isCoreReady) continue;   // 5條件通過
      }

      const last = data.candles[idx];

      // 短線第9條：KD向下不買
      if (last.kdK != null && idx > 0) {
        const prevKdK = data.candles[idx - 1]?.kdK;
        if (prevKdK != null && last.kdK < prevKdK) continue;
      }

      // 短線第10條：上影線>1/2不買
      const dayRange = last.high - last.low;
      const upperShadow = last.high - last.close;
      if (dayRange > 0 && upperShadow / dayRange > 0.5) continue;

      // 10大戒律
      const prohib = checkLongProhibitions(data.candles, idx);
      if (prohib.prohibited) continue;

      // 淘汰法 R1-R11
      const elimination = evaluateElimination(data.candles, idx);
      if (elimination.eliminated) continue;

      // 計算 3 個因子
      const mtf = evaluateMultiTimeframe(
        data.candles.slice(0, idx + 1),
        thresholds,
      );

      const signals = ruleEngine.evaluate(data.candles, idx);
      const buySignals = signals.filter(s => s.type === 'BUY' || s.type === 'ADD');
      const uniqueGroups = new Set(buySignals.map(s =>
        'groupId' in s ? (s as { groupId: string }).groupId : s.ruleId.split('.')[0]
      ));
      const resonanceScore = buySignals.length + uniqueGroups.size;

      let highWinRateScore = 0;
      try {
        const hwr = evaluateHighWinRateEntry(data.candles, idx);
        highWinRateScore = hwr.score;
      } catch {}

      candidates.push({
        symbol, name: data.name,
        candleIdx: idx, candles: data.candles,
        mtfScore: mtf.totalScore,
        resonanceScore,
        highWinRateScore,
      });
    }

    // Step 2: 每個 combo 各自排序取前3
    for (let ci = 0; ci < COMBOS.length; ci++) {
      const combo = COMBOS[ci];

      if (candidates.length === 0) {
        comboStats[ci].noCandidateDays++;
        continue;
      }

      // 歸一化分數（讓不同尺度的因子可比）
      // MTF: 0-4, resonance: 0~20+, highWinRate: 0-30
      // 用當天候選池的 max 做歸一化
      const maxR = Math.max(1, ...candidates.map(c => c.resonanceScore));
      const maxH = Math.max(1, ...candidates.map(c => c.highWinRateScore));
      const maxM = 4; // MTF 固定 0-4

      const sorted = [...candidates].sort((a, b) => {
        const sa = (a.mtfScore / maxM) * combo.wM + (a.resonanceScore / maxR) * combo.wR + (a.highWinRateScore / maxH) * combo.wH;
        const sb = (b.mtfScore / maxM) * combo.wM + (b.resonanceScore / maxR) * combo.wR + (b.highWinRateScore / maxH) * combo.wH;
        return sb - sa;
      });

      const top = sorted.slice(0, TOP_N);
      comboStats[ci].pickCount += top.length;

      for (const pick of top) {
        const rets = FORWARD_DAYS.map(d => forwardReturn(pick.candles, pick.candleIdx, d));
        for (let i = 0; i < FORWARD_DAYS.length; i++) {
          if (rets[i] != null) comboStats[ci].returns[i].push(rets[i]!);
        }
        comboStats[ci].dailyPicks.push({
          date, symbol: pick.symbol, name: pick.name,
          ret1d: forwardReturn(pick.candles, pick.candleIdx, 1),
        });
      }
    }
  }

  // ── 輸出結果 ──
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  各組合結果（每天前${TOP_N}檔）`);
  console.log(`═══════════════════════════════════════════════════\n`);

  // 表頭
  const header = '組合'.padEnd(26) +
    FORWARD_DAYS.map(d => `${d}D均報`.padStart(9)).join('') +
    FORWARD_DAYS.map(d => `${d}D勝率`.padStart(9)).join('') +
    '  筆數';
  console.log(header);
  console.log('─'.repeat(header.length));

  // 記錄每個天期的最佳 combo
  const bestByDay: { idx: number; avg: number }[] = FORWARD_DAYS.map(() => ({ idx: -1, avg: -999 }));

  for (let ci = 0; ci < COMBOS.length; ci++) {
    const combo = COMBOS[ci];
    const stats = comboStats[ci];

    const avgs = FORWARD_DAYS.map((_, i) => {
      const arr = stats.returns[i];
      if (arr.length === 0) return null;
      return arr.reduce((a, b) => a + b, 0) / arr.length;
    });

    const wins = FORWARD_DAYS.map((_, i) => {
      const arr = stats.returns[i];
      if (arr.length === 0) return null;
      return arr.filter(r => r > 0).length / arr.length * 100;
    });

    // 更新最佳
    for (let i = 0; i < FORWARD_DAYS.length; i++) {
      if (avgs[i] != null && avgs[i]! > bestByDay[i].avg) {
        bestByDay[i] = { idx: ci, avg: avgs[i]! };
      }
    }

    const avgStr = avgs.map(v =>
      v == null ? '     N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`.padStart(9)
    ).join('');

    const winStr = wins.map(v =>
      v == null ? '     N/A' : `${v.toFixed(1)}%`.padStart(9)
    ).join('');

    console.log(`${combo.name.padEnd(26)}${avgStr}${winStr}  ${stats.returns[0].length}`);
  }

  // ── 各天期冠軍 ──
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  各天期最佳組合`);
  console.log(`═══════════════════════════════════════════════════\n`);

  for (let i = 0; i < FORWARD_DAYS.length; i++) {
    const best = bestByDay[i];
    if (best.idx < 0) continue;
    const combo = COMBOS[best.idx];
    const arr = comboStats[best.idx].returns[i];
    const win = arr.filter(r => r > 0).length / arr.length * 100;
    console.log(
      `   ${FORWARD_DAYS[i]}D冠軍: ${combo.name}  ` +
      `均報: ${best.avg >= 0 ? '+' : ''}${best.avg.toFixed(2)}%  ` +
      `勝率: ${win.toFixed(1)}%`
    );
  }

  // ── 完整排名（含賺賠明細 + 累積報酬）──
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  1D 報酬完整排名`);
  console.log(`═══════════════════════════════════════════════════\n`);

  const ranked = COMBOS.map((combo, ci) => {
    const arr = comboStats[ci].returns[0];
    if (arr.length === 0) return { name: combo.name, ci, avg: -999, win: 0, n: 0, avgWin: 0, avgLoss: 0, maxWin: 0, maxLoss: 0, cumRet: 0, pf: 0 };
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const wins = arr.filter(r => r > 0);
    const losses = arr.filter(r => r <= 0);
    const winRate = wins.length / arr.length * 100;
    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const maxWin = arr.length > 0 ? Math.max(...arr) : 0;
    const maxLoss = arr.length > 0 ? Math.min(...arr) : 0;
    const cumRet = arr.reduce((a, b) => a + b, 0);
    const totalWin = wins.reduce((a, b) => a + b, 0);
    const totalLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const pf = totalLoss > 0 ? totalWin / totalLoss : 999;
    return { name: combo.name, ci, avg, win: winRate, n: arr.length, avgWin, avgLoss, maxWin, maxLoss, cumRet, pf };
  }).sort((a, b) => b.avg - a.avg);

  const medals = ['🥇', '🥈', '🥉'];
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const prefix = i < 3 ? medals[i] : '  ';
    const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
    console.log(
      `${prefix} ${(i + 1).toString().padStart(2)}. ${r.name.padEnd(26)} ` +
      `均報:${fmtPct(r.avg).padStart(8)}  勝率:${(r.win.toFixed(1) + '%').padStart(7)}  ` +
      `累積:${fmtPct(r.cumRet).padStart(10)}  ` +
      `(${r.n}筆)`
    );
    console.log(
      `      ${''.padEnd(26)} ` +
      `贏均:${fmtPct(r.avgWin).padStart(8)}  輸均:${fmtPct(r.avgLoss).padStart(8)}  ` +
      `最大賺:${fmtPct(r.maxWin).padStart(8)}  最大虧:${fmtPct(r.maxLoss).padStart(8)}  ` +
      `盈虧比:${r.pf.toFixed(2)}`
    );
  }

  // ── 累積報酬排名 ──
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  累積報酬排名（${tradingDays.length}天，每天選1檔持有1天）`);
  console.log(`═══════════════════════════════════════════════════\n`);

  const byCum = [...ranked].sort((a, b) => b.cumRet - a.cumRet);
  for (let i = 0; i < byCum.length; i++) {
    const r = byCum[i];
    const prefix = i < 3 ? medals[i] : '  ';
    const annualized = r.n > 0 ? r.cumRet / r.n * 250 : 0;
    console.log(
      `${prefix} ${(i + 1).toString().padStart(2)}. ${r.name.padEnd(26)} ` +
      `累積: ${r.cumRet >= 0 ? '+' : ''}${r.cumRet.toFixed(1)}%  ` +
      `年化: ${annualized >= 0 ? '+' : ''}${annualized.toFixed(0)}%  ` +
      `(${r.n}天)`
    );
  }

  // ── 冠軍每日明細 ──
  const champIdx = ranked[0].ci;
  const champName = ranked[0].name;
  const champPicks = comboStats[champIdx].dailyPicks;

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  冠軍「${champName}」每日選股明細`);
  console.log(`═══════════════════════════════════════════════════\n`);
  console.log(`${'日期'.padEnd(12)} ${'股票'.padEnd(12)} ${'名稱'.padEnd(8)} ${'1D漲幅'.padStart(8)}`);
  console.log('─'.repeat(44));

  let runningTotal = 0;
  for (const pick of champPicks) {
    const retStr = pick.ret1d == null ? '    N/A'
      : `${pick.ret1d >= 0 ? '+' : ''}${pick.ret1d.toFixed(2)}%`.padStart(8);
    if (pick.ret1d != null) runningTotal += pick.ret1d;
    console.log(`${pick.date.padEnd(12)} ${pick.symbol.padEnd(12)} ${pick.name.padEnd(8)} ${retStr}`);
  }
  console.log('─'.repeat(44));
  console.log(`累積報酬: ${runningTotal >= 0 ? '+' : ''}${runningTotal.toFixed(2)}%\n`);
}

main().catch(console.error);
