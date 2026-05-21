/**
 * Paper Trade 參數掃描 — 找最強 Tier 1 過濾組合
 *
 * 在 HOLD_DAYS × SIGNALS_PER_DAY × TOP_TURNOVER_RANK 網格上跑 paper-trade-simulator，
 * 輸出比較表，標出過 Phase 1 KPI 門檻（勝率 ≥52%、平均淨報酬 ≥2%）的組合。
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/paper-trade-sweep.ts
 *
 * 環境變數：
 *   MARKET=TW|CN          只跑單一市場（預設兩個都跑）
 *
 * 輸出：
 *   data/paper-portfolio/sweep-{today}.json
 *   data/paper-portfolio/sweep-{today}.md
 */

import fs from 'fs';
import path from 'path';
import { simulate, DEFAULT_SIM_CONFIG, type SimConfig, type SimResult } from './paper-trade-simulator';

const GRID = {
  holdDays:        [5, 10, 20],
  signalsPerDay:   [1, 3, 5],
  topTurnoverRank: [30, 50, 100],
};

const OUT_DIR = path.join(process.cwd(), 'data', 'paper-portfolio');

// Phase 1 KPI 門檻
const KPI = { winRate: 52, avgReturn: 2.0 };

interface SweepRow {
  market:          'TW' | 'CN';
  holdDays:        number;
  signalsPerDay:   number;
  topTurnoverRank: number;
  totalSignals:    number;
  totalPicks:      number;
  totalWins:       number;
  winRate:         number;
  avgReturn:       number;
  totalReturn:     number;
  finalEquity:     number;
  passWinRate:     boolean;
  passAvgReturn:   boolean;
  passBoth:        boolean;
}

function runOne(market: 'TW' | 'CN', holdDays: number, signalsPerDay: number, topTurnoverRank: number): SweepRow {
  const cfg: SimConfig = {
    ...DEFAULT_SIM_CONFIG,
    market, holdDays, signalsPerDay, topTurnoverRank,
  };
  const r: SimResult = simulate(cfg, { verbose: false });
  const passWinRate   = r.winRate   >= KPI.winRate;
  const passAvgReturn = r.avgReturn >= KPI.avgReturn;
  return {
    market, holdDays, signalsPerDay, topTurnoverRank,
    totalSignals: r.totalSignals,
    totalPicks:   r.totalPicks,
    totalWins:    r.totalWins,
    winRate:      r.winRate,
    avgReturn:    r.avgReturn,
    totalReturn:  r.totalReturn,
    finalEquity:  r.finalEquity,
    passWinRate, passAvgReturn,
    passBoth:     passWinRate && passAvgReturn,
  };
}

function fmtCell(row: SweepRow): string {
  const winStr = `${row.winRate.toFixed(1)}%`;
  const avgStr = `${row.avgReturn >= 0 ? '+' : ''}${row.avgReturn.toFixed(2)}%`;
  const tag = row.passBoth ? ' ✅' : row.passWinRate || row.passAvgReturn ? ' ⚠️' : '';
  return `${row.totalPicks}筆/${winStr}/${avgStr}${tag}`;
}

function main(): void {
  const markets: Array<'TW' | 'CN'> = (process.env.MARKET as 'TW' | 'CN' | undefined)
    ? [process.env.MARKET as 'TW' | 'CN']
    : ['TW', 'CN'];

  const rows: SweepRow[] = [];
  let count = 0;
  const total = markets.length * GRID.holdDays.length * GRID.signalsPerDay.length * GRID.topTurnoverRank.length;

  console.log(`\n── Paper Trade Sweep (${total} 組) ──\n`);

  for (const market of markets) {
    for (const holdDays of GRID.holdDays) {
      for (const signalsPerDay of GRID.signalsPerDay) {
        for (const topTurnoverRank of GRID.topTurnoverRank) {
          count++;
          process.stdout.write(`  [${count}/${total}] ${market} hold=${holdDays} signals=${signalsPerDay} top=${topTurnoverRank}...`);
          const row = runOne(market, holdDays, signalsPerDay, topTurnoverRank);
          rows.push(row);
          const tag = row.passBoth ? '✅' : row.passWinRate || row.passAvgReturn ? '⚠️' : '❌';
          process.stdout.write(` ${row.totalPicks}筆 ${row.winRate.toFixed(1)}% ${row.avgReturn >= 0 ? '+' : ''}${row.avgReturn.toFixed(2)}% ${tag}\n`);
        }
      }
    }
  }

  // ── 輸出 ──
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(OUT_DIR, `sweep-${today}.json`);
  const mdPath = path.join(OUT_DIR, `sweep-${today}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), grid: GRID, kpi: KPI, rows }, null, 2));

  const lines: string[] = [];
  lines.push(`# Paper Trade Sweep — ${today}`);
  lines.push('');
  lines.push(`掃描網格：HOLD_DAYS ∈ ${JSON.stringify(GRID.holdDays)} × SIGNALS_PER_DAY ∈ ${JSON.stringify(GRID.signalsPerDay)} × TOP_TURNOVER_RANK ∈ ${JSON.stringify(GRID.topTurnoverRank)}`);
  lines.push(`KPI 門檻：勝率 ≥ ${KPI.winRate}%、平均淨報酬 ≥ ${KPI.avgReturn}%`);
  lines.push(`圖示：✅ 兩項都過｜⚠️ 過其中一項｜（無標）兩項都未過`);
  lines.push('');

  for (const market of markets) {
    lines.push(`## ${market}`);
    lines.push('');
    lines.push(`### 完整網格`);
    lines.push('');
    lines.push(`格式：${'`進場數/勝率/平均單筆`'}`);
    lines.push('');
    for (const holdDays of GRID.holdDays) {
      lines.push(`#### hold = ${holdDays} 天`);
      lines.push('');
      lines.push(`| signals\\top | ${GRID.topTurnoverRank.map(t => `top ${t}`).join(' | ')} |`);
      lines.push(`|---:|${GRID.topTurnoverRank.map(() => '---:').join('|')}|`);
      for (const signalsPerDay of GRID.signalsPerDay) {
        const cells = GRID.topTurnoverRank.map(top => {
          const row = rows.find(r => r.market === market && r.holdDays === holdDays && r.signalsPerDay === signalsPerDay && r.topTurnoverRank === top);
          return row ? fmtCell(row) : '-';
        });
        lines.push(`| **${signalsPerDay}** | ${cells.join(' | ')} |`);
      }
      lines.push('');
    }

    // 通過榜
    const passed = rows.filter(r => r.market === market && r.passBoth)
      .sort((a, b) => b.totalReturn - a.totalReturn);
    lines.push(`### 通過 KPI 門檻 (${passed.length} 組)`);
    lines.push('');
    if (passed.length === 0) {
      lines.push(`_無組合同時過勝率 ≥ ${KPI.winRate}% + 平均報酬 ≥ ${KPI.avgReturn}%_`);
    } else {
      lines.push(`| hold | signals | top | 進場 | 勝率 | 平均單筆 | 總報酬 | 最終資金 |`);
      lines.push(`|---:|---:|---:|---:|---:|---:|---:|---:|`);
      for (const r of passed) {
        lines.push(`| ${r.holdDays} | ${r.signalsPerDay} | ${r.topTurnoverRank} | ${r.totalPicks} | ${r.winRate.toFixed(1)}% | ${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(2)}% | ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn.toFixed(2)}% | $${r.finalEquity.toLocaleString()} |`);
      }
    }
    lines.push('');

    // 半通過榜（過一項）
    const halfPassed = rows.filter(r => r.market === market && (r.passWinRate !== r.passAvgReturn))
      .sort((a, b) => b.totalReturn - a.totalReturn).slice(0, 10);
    lines.push(`### 半通過榜（過勝率或過報酬其中一項，依總報酬 top 10）`);
    lines.push('');
    if (halfPassed.length === 0) {
      lines.push(`_無_`);
    } else {
      lines.push(`| hold | signals | top | 進場 | 勝率 | 平均單筆 | 總報酬 | 過勝率 | 過報酬 |`);
      lines.push(`|---:|---:|---:|---:|---:|---:|---:|:--:|:--:|`);
      for (const r of halfPassed) {
        lines.push(`| ${r.holdDays} | ${r.signalsPerDay} | ${r.topTurnoverRank} | ${r.totalPicks} | ${r.winRate.toFixed(1)}% | ${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(2)}% | ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn.toFixed(2)}% | ${r.passWinRate ? '✓' : ''} | ${r.passAvgReturn ? '✓' : ''} |`);
      }
    }
    lines.push('');

    // 總報酬 top 5
    const top5 = rows.filter(r => r.market === market).sort((a, b) => b.totalReturn - a.totalReturn).slice(0, 5);
    lines.push(`### 總報酬 Top 5`);
    lines.push('');
    lines.push(`| hold | signals | top | 進場 | 勝率 | 平均單筆 | 總報酬 |`);
    lines.push(`|---:|---:|---:|---:|---:|---:|---:|`);
    for (const r of top5) {
      const tag = r.passBoth ? ' ✅' : '';
      lines.push(`| ${r.holdDays} | ${r.signalsPerDay} | ${r.topTurnoverRank} | ${r.totalPicks} | ${r.winRate.toFixed(1)}% | ${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn.toFixed(2)}% | **${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn.toFixed(2)}%**${tag} |`);
    }
    lines.push('');
  }

  fs.writeFileSync(mdPath, lines.join('\n'));
  console.log(`\n  寫入 ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`  寫入 ${path.relative(process.cwd(), mdPath)}\n`);

  // 結尾摘要
  for (const market of markets) {
    const passed = rows.filter(r => r.market === market && r.passBoth);
    console.log(`  [${market}] 通過 KPI: ${passed.length}/${rows.filter(r => r.market === market).length} 組`);
  }
}

main();
