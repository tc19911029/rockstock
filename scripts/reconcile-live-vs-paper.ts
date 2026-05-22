/**
 * Phase 4: 實盤 vs Paper vs Backtest 三方對帳
 *
 * 用法：累積實盤交易紀錄到 data/live-trades/{date}.json，每月跑此腳本對帳。
 *
 * 對帳維度：
 * 1. 滑價（actualEntryPrice vs systemEntryPrice）
 * 2. 執行時機差（actualEntryTime vs 訊號日 next-open）
 * 3. 出場差（actualExitPrice vs system 建議出場 vs backtest exit）
 * 4. 三方損益差（live PnL vs paper PnL vs backtest PnL）
 *
 * Usage:
 *   FROM=2026-05-22 TO=2026-06-22 npx tsx scripts/reconcile-live-vs-paper.ts
 *
 * 輸入：data/live-trades/{date}.json（schema 見下）
 * 輸入：data/paper-portfolio/equity-curve-TW.json（paper trade 累計）
 * 輸出：
 *   data/live-reconcile/monthly-{from}-{to}.json
 *   docs/audit/live-reconcile-{from}-{to}.md
 *
 * --------
 * data/live-trades/{date}.json schema：
 * {
 *   "date": "2026-05-23",
 *   "trades": [
 *     {
 *       "symbol": "8299.TWO",
 *       "name": "群聯",
 *       "signal": {
 *         "signalDate": "2026-05-22",
 *         "systemEntryPrice": 1901.9,      // simulator/scan blob 訊號日收盤
 *         "tier": "A",                       // sweep winning combo 訊號等級
 *         "exitSuggestedDate": null,         // 系統建議出場日（null = 尚未出場）
 *         "exitSuggestedReason": null
 *       },
 *       "actual": {
 *         "entryPrice": 1905,                // 實際成交價
 *         "entryTime": "2026-05-23T09:01:00+0800",
 *         "shares": 1000,
 *         "exitPrice": null,                 // 尚未出場
 *         "exitTime": null,
 *         "exitReason": null,
 *         "slippagePct": 0.16                // (1905 - 1901.9) / 1901.9 * 100
 *       },
 *       "backtest": {
 *         "exitPrice": 2322.675,             // simulator 模擬出場
 *         "exitReason": "profitClimaxExit",
 *         "exitDate": "2026-05-30",
 *         "netReturnPct": 21.57
 *       }
 *     }
 *   ]
 * }
 *
 * --------
 * 啟用前提（baseline-kpi.md Phase 4 條件）：
 * 1. paper trading 累積 ≥ 1 個月（≥ 20 個交易日）
 * 2. paper 月勝率 ≥ 2/3
 * 3. 用戶實際開券商帳戶開始小資金實盤（單筆 ≤ NT$50k）
 */

import fs from 'fs';
import path from 'path';

const LIVE_TRADES_DIR = path.join(process.cwd(), 'data', 'live-trades');
const RECONCILE_DIR   = path.join(process.cwd(), 'data', 'live-reconcile');
const AUDIT_DIR       = path.join(process.cwd(), 'docs', 'audit');

interface LiveTrade {
  symbol: string;
  name: string;
  signal: {
    signalDate: string;
    systemEntryPrice: number;
    tier: string;
    exitSuggestedDate: string | null;
    exitSuggestedReason: string | null;
  };
  actual: {
    entryPrice: number;
    entryTime: string;
    shares: number;
    exitPrice: number | null;
    exitTime: string | null;
    exitReason: string | null;
    slippagePct: number;
  };
  backtest: {
    exitPrice: number;
    exitReason: string;
    exitDate: string;
    netReturnPct: number;
  };
}

interface LiveTradeFile { date: string; trades: LiveTrade[] }

function listLiveTradeDates(from: string, to: string): string[] {
  if (!fs.existsSync(LIVE_TRADES_DIR)) return [];
  return fs.readdirSync(LIVE_TRADES_DIR)
    .map(f => f.match(/^(\d{4}-\d{2}-\d{2})\.json$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => m[1])
    .filter(d => d >= from && d <= to)
    .sort();
}

function loadLiveTrades(date: string): LiveTradeFile | null {
  const file = path.join(LIVE_TRADES_DIR, `${date}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as LiveTradeFile; } catch { return null; }
}

interface Stats {
  trades:          LiveTrade[];
  totalCount:      number;
  closedCount:     number;
  openCount:       number;
  liveWins:        number;
  paperWins:       number;
  avgSlippagePct:  number;
  slippageStdDev:  number;
  // 三方損益差
  livePnLPct:      number[];
  paperPnLPct:     number[];
  livePaperGap:    number[];   // live - paper
}

function calcStats(trades: LiveTrade[]): Stats {
  const closed = trades.filter(t => t.actual.exitPrice != null);
  const liveWins = closed.filter(t => (t.actual.exitPrice! - t.actual.entryPrice) > 0).length;
  const paperWins = closed.filter(t => t.backtest.netReturnPct > 0).length;
  const slippages = trades.map(t => t.actual.slippagePct);
  const avgSlippage = slippages.reduce((s, x) => s + x, 0) / (slippages.length || 1);
  const variance = slippages.reduce((s, x) => s + (x - avgSlippage) ** 2, 0) / (slippages.length || 1);
  const livePnL  = closed.map(t => (t.actual.exitPrice! - t.actual.entryPrice) / t.actual.entryPrice * 100);
  const paperPnL = closed.map(t => t.backtest.netReturnPct);
  const gaps     = closed.map((t, i) => livePnL[i] - paperPnL[i]);
  return {
    trades,
    totalCount: trades.length,
    closedCount: closed.length,
    openCount: trades.length - closed.length,
    liveWins, paperWins,
    avgSlippagePct: +avgSlippage.toFixed(3),
    slippageStdDev: +Math.sqrt(variance).toFixed(3),
    livePnLPct: livePnL,
    paperPnLPct: paperPnL,
    livePaperGap: gaps,
  };
}

function writeReport(from: string, to: string, stats: Stats): void {
  if (!fs.existsSync(RECONCILE_DIR)) fs.mkdirSync(RECONCILE_DIR, { recursive: true });
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });

  const jsonPath = path.join(RECONCILE_DIR, `monthly-${from}-${to}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ from, to, stats, generatedAt: new Date().toISOString() }, null, 2));

  const mdPath = path.join(AUDIT_DIR, `live-reconcile-${from}-${to}.md`);
  const lines: string[] = [];
  lines.push(`# Live vs Paper Reconcile — ${from} → ${to}`);
  lines.push('');
  lines.push(`產出時間：${new Date().toISOString()}`);
  lines.push('');
  lines.push(`## 統計`);
  lines.push(`| 項目 | 數值 |`);
  lines.push(`|---|---:|`);
  lines.push(`| 總交易數 | ${stats.totalCount} |`);
  lines.push(`| 已平倉 | ${stats.closedCount} |`);
  lines.push(`| 未平倉 | ${stats.openCount} |`);
  lines.push(`| 實盤勝率 | ${stats.closedCount > 0 ? (stats.liveWins / stats.closedCount * 100).toFixed(1) : '-'}% |`);
  lines.push(`| Paper 勝率 | ${stats.closedCount > 0 ? (stats.paperWins / stats.closedCount * 100).toFixed(1) : '-'}% |`);
  lines.push(`| 平均滑價 | ${stats.avgSlippagePct}% |`);
  lines.push(`| 滑價標準差 | ${stats.slippageStdDev}% |`);

  const liveAvg = stats.livePnLPct.length > 0 ? stats.livePnLPct.reduce((s, x) => s + x, 0) / stats.livePnLPct.length : 0;
  const paperAvg = stats.paperPnLPct.length > 0 ? stats.paperPnLPct.reduce((s, x) => s + x, 0) / stats.paperPnLPct.length : 0;
  const avgGap = stats.livePaperGap.length > 0 ? stats.livePaperGap.reduce((s, x) => s + x, 0) / stats.livePaperGap.length : 0;
  lines.push(`| 實盤平均單筆 | ${liveAvg >= 0 ? '+' : ''}${liveAvg.toFixed(2)}% |`);
  lines.push(`| Paper 平均單筆 | ${paperAvg >= 0 ? '+' : ''}${paperAvg.toFixed(2)}% |`);
  lines.push(`| 平均落差（live - paper） | ${avgGap >= 0 ? '+' : ''}${avgGap.toFixed(2)}% |`);
  lines.push('');

  // KPI 判定（依 baseline-kpi.md Phase 4 通過門檻）
  lines.push(`## Phase 4 KPI 判定`);
  const liveWinRate = stats.closedCount > 0 ? stats.liveWins / stats.closedCount * 100 : 0;
  const paperWinRate = stats.closedCount > 0 ? stats.paperWins / stats.closedCount * 100 : 0;
  const winRatePass = liveWinRate >= paperWinRate * 0.8;
  const slippagePass = stats.avgSlippagePct <= 0.3;
  const gapStd = Math.sqrt(stats.livePaperGap.reduce((s, x) => s + (x - avgGap) ** 2, 0) / (stats.livePaperGap.length || 1));
  const gapPass = gapStd <= 1.0;
  lines.push(`| 門檻 | 目標 | 實際 | 通過 |`);
  lines.push(`|---|---|---:|:--:|`);
  lines.push(`| 實盤勝率 ≥ paper × 0.8 | ${(paperWinRate * 0.8).toFixed(1)}% | ${liveWinRate.toFixed(1)}% | ${winRatePass ? '✅' : '❌'} |`);
  lines.push(`| 平均滑價 ≤ 0.3% | 0.3% | ${stats.avgSlippagePct}% | ${slippagePass ? '✅' : '❌'} |`);
  lines.push(`| 三方損益差標準差 ≤ 1% | 1.0% | ${gapStd.toFixed(2)}% | ${gapPass ? '✅' : '❌'} |`);
  lines.push('');

  // 逐筆明細
  lines.push(`## 逐筆對帳`);
  lines.push(`| 訊號日 | 標的 | 系統價 | 實際進場 | 滑價 | 實際出場 | Paper PnL | Live PnL | 落差 |`);
  lines.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const t of stats.trades) {
    const livePnL = t.actual.exitPrice != null
      ? (t.actual.exitPrice - t.actual.entryPrice) / t.actual.entryPrice * 100
      : null;
    const gap = livePnL != null ? livePnL - t.backtest.netReturnPct : null;
    lines.push(`| ${t.signal.signalDate} | ${t.symbol} ${t.name} | ${t.signal.systemEntryPrice} | ${t.actual.entryPrice} | ${t.actual.slippagePct}% | ${t.actual.exitPrice ?? '-'} | ${t.backtest.netReturnPct >= 0 ? '+' : ''}${t.backtest.netReturnPct}% | ${livePnL != null ? (livePnL >= 0 ? '+' : '') + livePnL.toFixed(2) + '%' : '-'} | ${gap != null ? (gap >= 0 ? '+' : '') + gap.toFixed(2) + '%' : '-'} |`);
  }
  lines.push('');

  fs.writeFileSync(mdPath, lines.join('\n'));
  console.log(`  寫入 ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`  寫入 ${path.relative(process.cwd(), mdPath)}`);
}

function main(): void {
  const from = process.env.FROM ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const to   = process.env.TO   ?? new Date().toISOString().slice(0, 10);

  console.log('\n── Live vs Paper Reconcile ──');
  console.log(`  期間：${from} ~ ${to}`);

  const dates = listLiveTradeDates(from, to);
  if (dates.length === 0) {
    console.log(`\n  ⚠️  ${LIVE_TRADES_DIR} 目錄沒有 ${from} ~ ${to} 範圍的交易紀錄。`);
    console.log(`     Phase 4 啟動前提：每筆實盤交易要手動記錄成 data/live-trades/{date}.json`);
    console.log(`     範例 schema 見本腳本檔頭註解。\n`);
    return;
  }

  const allTrades: LiveTrade[] = [];
  for (const date of dates) {
    const file = loadLiveTrades(date);
    if (file) allTrades.push(...file.trades);
  }
  console.log(`  載入 ${allTrades.length} 筆實盤交易（${dates.length} 個交易日）`);

  const stats = calcStats(allTrades);
  console.log(`  實盤勝率：${stats.closedCount > 0 ? (stats.liveWins / stats.closedCount * 100).toFixed(1) : '-'}%`);
  console.log(`  Paper 勝率：${stats.closedCount > 0 ? (stats.paperWins / stats.closedCount * 100).toFixed(1) : '-'}%`);
  console.log(`  平均滑價：${stats.avgSlippagePct}%`);

  writeReport(from, to, stats);
  console.log('');
}

main();
