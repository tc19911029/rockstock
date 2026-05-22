/**
 * Paper Trade Simulator — CLI wrapper
 *
 * 核心邏輯在 [lib/paper/paperTradeSimulator.ts](../lib/paper/paperTradeSimulator.ts)，
 * 此檔只負責 CLI：從 env 讀 config、跑 simulate、寫 markdown 報告。
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/paper-trade-simulator.ts
 *
 * 環境變數：
 *   MARKET=TW|CN
 *   SIGNALS_PER_DAY=3
 *   HOLD_DAYS=10
 *   CAPITAL=1000000
 *   FORWARD_DAYS=30
 *   TOP_TURNOVER_RANK=50
 *
 * 輸出：
 *   data/paper-portfolio/simulator-{market}-{today}.json
 *   data/paper-portfolio/simulator-{market}-{today}.md
 */

import fs from 'fs';
import path from 'path';
import {
  simulate, DEFAULT_SIM_CONFIG,
  type SimConfig, type SimResult, type DayResult,
} from '@/lib/paper/paperTradeSimulator';

const OUT_DIR = path.join(process.cwd(), 'data', 'paper-portfolio');

function configFromEnv(): SimConfig {
  return {
    ...DEFAULT_SIM_CONFIG,
    market:          (process.env.MARKET ?? DEFAULT_SIM_CONFIG.market) as 'TW' | 'CN',
    signalsPerDay:   Number(process.env.SIGNALS_PER_DAY  ?? DEFAULT_SIM_CONFIG.signalsPerDay),
    holdDays:        Number(process.env.HOLD_DAYS        ?? DEFAULT_SIM_CONFIG.holdDays),
    capital:         Number(process.env.CAPITAL          ?? DEFAULT_SIM_CONFIG.capital),
    forwardDays:     Number(process.env.FORWARD_DAYS     ?? DEFAULT_SIM_CONFIG.forwardDays),
    topTurnoverRank: Number(process.env.TOP_TURNOVER_RANK ?? DEFAULT_SIM_CONFIG.topTurnoverRank),
  };
}

function writeReport(r: SimResult): void {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(OUT_DIR, `simulator-${r.market}-${today}.json`);
  const mdPath = path.join(OUT_DIR, `simulator-${r.market}-${today}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(r, null, 2));

  const lines: string[] = [];
  lines.push(`# Paper Trade Simulator — ${r.market}`);
  lines.push('');
  lines.push(`產出時間：${new Date().toISOString()}`);
  lines.push(`期間：${r.days[0]?.date ?? '-'} ~ ${r.days[r.days.length - 1]?.date ?? '-'}（${r.days.length} 個交易日）`);
  lines.push('');
  lines.push(`## 過濾條件`);
  lines.push(`- 六條件分數 ≥ ${r.config.minSixCondScore}`);
  lines.push(`- 命中 A 級策略字母（${[...r.config.aLevelMethods].join('/')}）`);
  lines.push(`- 成交額排名 top ${r.config.topTurnoverRank}`);
  lines.push(`- 每日進場 ${r.config.signalsPerDay} 檔（依成交額排名）`);
  lines.push(`- 持有 ${r.config.holdDays} 天 + 移動停利 (3% 回撤，5% 啟動) + 停損 -7%`);
  lines.push('');
  lines.push(`## 統計`);
  lines.push(`| 項目 | 數值 |`);
  lines.push(`|---|---:|`);
  lines.push(`| 總 Tier 1 訊號數 | ${r.totalSignals} |`);
  lines.push(`| 實際進場數 | ${r.totalPicks} |`);
  lines.push(`| 勝場 | ${r.totalWins} |`);
  lines.push(`| 勝率 | ${r.winRate}% |`);
  lines.push(`| 平均單筆淨報酬 | ${r.avgReturn}% |`);
  lines.push(`| 初始資金 | $${r.config.capital.toLocaleString()} |`);
  lines.push(`| 最終資金 | $${r.finalEquity.toLocaleString()} |`);
  lines.push(`| 期間總報酬 | **${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}%** |`);
  lines.push('');
  lines.push(`## 每日明細（後 20 天）`);
  lines.push(`| 日期 | 訊號數 | 進場 | 日均報酬 | 累計資金 |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  const showDays = r.days.slice(-20);
  const equityMap = new Map(r.equityCurve.map(e => [e.date, e.equity]));
  for (const d of showDays) {
    lines.push(`| ${d.date} | ${d.signals} | ${d.picks} | ${d.avgReturn >= 0 ? '+' : ''}${d.avgReturn}% | $${(equityMap.get(d.date) ?? 0).toLocaleString()} |`);
  }
  lines.push('');
  lines.push(`## 全部進場明細（後 30 筆）`);
  lines.push(`| 日期 | 標的 | 進場 | 出場 | 淨報酬 | 持有 | 出場原因 |`);
  lines.push(`|---|---|---:|---:|---:|---:|---|`);
  const allPicks: Array<{ date: string } & DayResult['picksDetail'][number]> = [];
  for (const d of r.days) for (const p of d.picksDetail) allPicks.push({ date: d.date, ...p });
  const showPicks = allPicks.slice(-30);
  for (const p of showPicks) {
    lines.push(`| ${p.date} | ${p.symbol} ${p.name} | ${p.entryPrice} | ${p.exitPrice} | ${p.netReturnPct >= 0 ? '+' : ''}${p.netReturnPct}% | ${p.holdDays}d | ${p.exitReason} |`);
  }
  lines.push('');
  fs.writeFileSync(mdPath, lines.join('\n'));
  console.log(`  寫入 ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`  寫入 ${path.relative(process.cwd(), mdPath)}`);
}

function main(): void {
  const cfg = configFromEnv();
  console.log('\n── Paper Trade Simulator ──');
  console.log(`  config: market=${cfg.market} signals/day=${cfg.signalsPerDay} hold=${cfg.holdDays} top=${cfg.topTurnoverRank}`);
  const r = simulate(cfg, { verbose: true });

  console.log('');
  console.log(`  總訊號數：${r.totalSignals}`);
  console.log(`  進場數：  ${r.totalPicks}`);
  console.log(`  勝率：    ${r.winRate}%`);
  console.log(`  平均單筆：${r.avgReturn}%`);
  console.log(`  初始：    $${cfg.capital.toLocaleString()}`);
  console.log(`  最終：    $${r.finalEquity.toLocaleString()}`);
  console.log(`  總報酬：  ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}%`);

  writeReport(r);
  console.log('');
}

main();
