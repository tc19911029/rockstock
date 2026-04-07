/**
 * Output Formatter — 結果輸出（Console + JSON）
 */

import fs from 'fs';
import type {
  OptimizerConfig,
  PhaseAResult,
  PhaseBResult,
  PhaseCResult,
  PhaseDResult,
  WalkForwardResult,
  StrategyMetrics,
  WeightCombo,
  DailyCandidate,
  DailyDetail,
  OptimizerOutput,
} from './types';
import { rankCandidates } from './rankingEngine';

const fmtPct = (v: number | null | undefined) =>
  v == null ? '     N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`.padStart(8);

const fmtNum = (v: number | null | undefined, decimals = 2) =>
  v == null ? '   N/A' : v.toFixed(decimals).padStart(7);

// ── Phase A Output ──────────────────────────────────────────────────────────────

export function printPhaseA(result: PhaseAResult): void {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Phase A: 單因子排序能力比較');
  console.log('  （MTF門檻=0，每天買排名第1，朱SOP出場）');
  console.log('═══════════════════════════════════════════════════\n');

  const header = '因子'.padEnd(12) +
    '均報'.padStart(8) + '勝率'.padStart(7) + '筆數'.padStart(6) +
    '最大回撤'.padStart(9) + 'Sharpe'.padStart(8) + '盈虧比'.padStart(8) +
    '年化'.padStart(8) + '均持'.padStart(6) +
    'Top1>2'.padStart(8) + 'Spearman'.padStart(10);
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const { factor, metrics: m } of result.results) {
    console.log(
      factor.padEnd(12) +
      fmtPct(m.avgReturn) +
      `${m.winRate.toFixed(1)}%`.padStart(7) +
      `${m.tradeCount}`.padStart(6) +
      fmtPct(m.maxDrawdown) +
      fmtNum(m.sharpeRatio, 3).padStart(8) +
      fmtNum(m.profitFactor, 2).padStart(8) +
      fmtPct(m.annualReturn) +
      `${m.avgHoldDays.toFixed(0)}d`.padStart(6) +
      `${m.top1BeatsTop2Pct.toFixed(0)}%`.padStart(8) +
      fmtNum(m.rankReturnSpearman, 3).padStart(10)
    );
  }
}

// ── Phase B Output ──────────────────────────────────────────────────────────────

export function printPhaseB(result: PhaseBResult): void {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Phase B: MTF 門檻測試（等權1:1:1，每天買第1名）');
  console.log('═══════════════════════════════════════════════════\n');

  const header = '門檻'.padEnd(8) + '日均候選'.padStart(8) +
    '均報'.padStart(8) + '勝率'.padStart(7) + '筆數'.padStart(6) +
    '最大回撤'.padStart(9) + 'Sharpe'.padStart(8) + '年化'.padStart(8) + '均持'.padStart(6);
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const { threshold, avgCandidateCount: avg, metrics: m } of result.results) {
    console.log(
      `MTF≥${threshold}`.padEnd(8) +
      `${avg}`.padStart(8) +
      fmtPct(m.avgReturn) +
      `${m.winRate.toFixed(1)}%`.padStart(7) +
      `${m.tradeCount}`.padStart(6) +
      fmtPct(m.maxDrawdown) +
      fmtNum(m.sharpeRatio, 3).padStart(8) +
      fmtPct(m.annualReturn) +
      `${m.avgHoldDays.toFixed(0)}d`.padStart(6)
    );
  }

  // By-year breakdown for each threshold
  console.log('\n  各年份表現：');
  for (const { threshold, metrics: m } of result.results) {
    const years = Object.entries(m.byYear)
      .map(([y, ym]) => `${y}:${fmtPct(ym.avgReturn).trim()}/${ym.winRate.toFixed(0)}%`)
      .join('  ');
    console.log(`   MTF≥${threshold}  ${years}`);
  }
}

// ── Phase C Output ──────────────────────────────────────────────────────────────

export function printPhaseC(result: PhaseCResult): void {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Phase C: 權重組合 Top-10 排名');
  console.log('═══════════════════════════════════════════════════\n');

  const medals = ['🥇', '🥈', '🥉'];
  for (let i = 0; i < result.top10.length; i++) {
    const { threshold, combo, metrics: m } = result.top10[i];
    const prefix = i < 3 ? medals[i] : '  ';
    console.log(
      `${prefix} ${(i + 1).toString().padStart(2)}. MTF≥${threshold} ${combo.name.padEnd(8)} ` +
      `均報:${fmtPct(m.avgReturn)}  勝率:${m.winRate.toFixed(1)}%  ` +
      `年化:${fmtPct(m.annualReturn)}  最大回撤:${fmtPct(m.maxDrawdown)}  ` +
      `盈虧比:${m.profitFactor.toFixed(2)}  Sharpe:${fmtNum(m.sharpeRatio, 3)}  ` +
      `均持:${m.avgHoldDays.toFixed(0)}d  (${m.tradeCount}筆)`
    );
  }

  // Exit reason distribution for top strategy
  if (result.top10.length > 0) {
    const best = result.top10[0].metrics;
    console.log('\n  冠軍出場原因分佈：');
    const sorted = Object.entries(best.exitReasonDist)
      .sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sorted) {
      const pct = ((count / best.tradeCount) * 100).toFixed(1);
      console.log(`   ${reason.padEnd(30)} ${count.toString().padStart(4)}筆 (${pct}%)`);
    }
  }
}

// ── Phase D Output ──────────────────────────────────────────────────────────────

export function printPhaseD(result: PhaseDResult): void {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Phase D: 對照組比較');
  console.log('═══════════════════════════════════════════════════\n');

  for (const { topN, metrics: m } of result.topNComparison) {
    console.log(
      `  Top-${topN}: `.padEnd(10) +
      `均報:${fmtPct(m.avgReturn)}  勝率:${m.winRate.toFixed(1)}%  ` +
      `年化:${fmtPct(m.annualReturn)}  盈虧比:${m.profitFactor.toFixed(2)}  ` +
      `(${m.tradeCount}筆)`
    );
  }

  const rm = result.randomBaseline;
  console.log(
    `  隨機:    `.padEnd(10) +
    `均報:${fmtPct(rm.avgReturn)}  勝率:${rm.winRate.toFixed(1)}%  ` +
    `年化:${fmtPct(rm.annualReturn)}  盈虧比:${rm.profitFactor.toFixed(2)}  ` +
    `(${rm.tradeCount}筆)`
  );

  // Top-1 quality
  const top1 = result.topNComparison.find(t => t.topN === 1)?.metrics;
  if (top1) {
    console.log('\n  排序品質：');
    console.log(`   Top-1 優於 Top-2 的天數比例: ${top1.top1BeatsTop2Pct.toFixed(1)}%`);
    console.log(`   Top-1 優於 Top-3 的天數比例: ${top1.top1BeatsTop3Pct.toFixed(1)}%`);
    console.log(`   Top-1 為 Top-5 最佳的比例:   ${top1.top1BestInTop5Pct.toFixed(1)}%`);
    console.log(`   排名-報酬 Spearman 相關性:   ${fmtNum(top1.rankReturnSpearman, 3)}`);
    console.log(`   （正相關 = 排名越前報酬越高，排序有效）`);
  }
}

// ── Walk-Forward Output ─────────────────────────────────────────────────────────

export function printWalkForward(result: WalkForwardResult): void {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Walk-Forward 驗證');
  console.log('═══════════════════════════════════════════════════\n');

  const { strategy, trainMetrics: tr, testMetrics: te } = result;
  console.log(`   策略: MTF≥${strategy.threshold} + ${strategy.combo.name}`);
  console.log('');
  console.log(`                     訓練期          驗證期`);
  console.log(`   均報:          ${fmtPct(tr.avgReturn)}       ${fmtPct(te.avgReturn)}`);
  console.log(`   勝率:          ${tr.winRate.toFixed(1).padStart(6)}%       ${te.winRate.toFixed(1).padStart(6)}%`);
  console.log(`   年化:        ${fmtPct(tr.annualReturn)}     ${fmtPct(te.annualReturn)}`);
  console.log(`   最大回撤:    ${fmtPct(tr.maxDrawdown)}     ${fmtPct(te.maxDrawdown)}`);
  console.log(`   盈虧比:        ${tr.profitFactor.toFixed(2).padStart(6)}       ${te.profitFactor.toFixed(2).padStart(6)}`);
  console.log(`   均持天數:      ${tr.avgHoldDays.toFixed(0).padStart(6)}        ${te.avgHoldDays.toFixed(0).padStart(6)}`);
  console.log(`   筆數:          ${tr.tradeCount.toString().padStart(6)}        ${te.tradeCount.toString().padStart(6)}`);

  console.log(`\n   效率比: ${(result.efficiencyRatio * 100).toFixed(1)}% (驗證/訓練)`);

  const { trainMetrics: tm, testMetrics: tsm } = result;
  if (result.isOverfit) {
    console.log('   ❌ 過擬合風險：驗證期均報 < 訓練期的50%');
  } else if (tm.avgReturn <= 0 && tsm.avgReturn <= 0) {
    console.log('   ⚠️ 訓練期與驗證期均虧損，策略本身需改進');
  } else if (tm.avgReturn <= 0 && tsm.avgReturn > 0) {
    console.log('   ⚠️ 訓練期虧損但驗證期盈利，結果不穩定需謹慎');
  } else if (tsm.avgReturn <= 0) {
    console.log('   ❌ 驗證期虧損');
  } else {
    console.log('   ✅ 策略穩健：驗證期表現維持');
  }
}

// ── Daily Detail ────────────────────────────────────────────────────────────────

export function printDailyDetail(
  dailyCandidates: Map<string, DailyCandidate[]>,
  days:            string[],
  combo:           WeightCombo,
  mtfThreshold:    number,
): DailyDetail[] {
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  最佳策略每日明細（MTF≥${mtfThreshold} + ${combo.name}）`);
  console.log('═══════════════════════════════════════════════════\n');

  const header = '日期'.padEnd(12) + '股票'.padEnd(12) + '名稱'.padEnd(10) +
    '進場'.padStart(8) + '出場'.padStart(8) + '報酬'.padStart(8) +
    '持有'.padStart(5) + '出場原因'.padEnd(28) + '累積'.padStart(8);
  console.log(header);
  console.log('─'.repeat(header.length));

  const details: DailyDetail[] = [];
  let equity = 1;
  let holdingUntilIdx = -1; // 真實資金流：持有中就跳過

  for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
    const date = days[dayIdx];
    if (dayIdx <= holdingUntilIdx) continue; // 還在持有，跳過

    const candidates = dailyCandidates.get(date);
    if (!candidates || candidates.length === 0) continue;

    const ranked = rankCandidates(candidates, combo, mtfThreshold);
    if (ranked.length === 0) continue;

    const pick = ranked[0];
    if (!pick.tradeResult) continue;

    const tr = pick.tradeResult;
    holdingUntilIdx = dayIdx + tr.holdDays; // 標記持有期間
    equity *= (1 + tr.netReturn / 100);
    const cumReturn = (equity - 1) * 100;

    details.push({
      date,
      symbol:     pick.symbol,
      name:       pick.name,
      entryPrice: tr.entryPrice,
      exitPrice:  tr.exitPrice,
      netReturn:  tr.netReturn,
      exitReason: tr.exitReason,
      holdDays:   tr.holdDays,
      cumReturn:  +cumReturn.toFixed(2),
    });

    console.log(
      date.padEnd(12) +
      pick.symbol.padEnd(12) +
      pick.name.slice(0, 8).padEnd(10) +
      tr.entryPrice.toFixed(2).padStart(8) +
      tr.exitPrice.toFixed(2).padStart(8) +
      fmtPct(tr.netReturn) +
      `${tr.holdDays}d`.padStart(5) +
      ` ${tr.exitReason.padEnd(27)}` +
      fmtPct(cumReturn)
    );
  }

  console.log('─'.repeat(header.length));
  console.log(`累積報酬: ${fmtPct((equity - 1) * 100)}  (${details.length}筆)\n`);

  return details;
}

// ── JSON Export ──────────────────────────────────────────────────────────────────

export function exportJson(
  outputPath: string,
  config:     OptimizerConfig,
  phaseA:     PhaseAResult,
  phaseB:     PhaseBResult,
  phaseC:     PhaseCResult,
  phaseD:     PhaseDResult,
  walkForward: WalkForwardResult,
  bestStrategy: { mtfThreshold: number; combo: WeightCombo; metrics: StrategyMetrics },
  dailyDetail: DailyDetail[],
): void {
  // Equity curve from daily detail
  let equity = 1;
  const equityCurve = dailyDetail.map(d => {
    equity = 1 + d.cumReturn / 100;
    return { date: d.date, equity: +equity.toFixed(4) };
  });

  const output: OptimizerOutput = {
    config,
    phaseA,
    phaseB,
    phaseC,
    phaseD,
    walkForward,
    bestStrategy,
    dailyDetail,
    equityCurve,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n📄 結果已匯出至 ${outputPath}`);
}
