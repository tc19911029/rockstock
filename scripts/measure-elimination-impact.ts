/**
 * 量測「淘汰法 hard gate 回滾」對 Step 1 池子的影響
 *
 * 在 2026-05-22 把淘汰法從「警示不擋」回滾為「立即出場」之後，
 * 池子會縮小多少？哪幾條淘汰規則最常觸發？哪些日期最敏感？
 *
 * 方法：
 *   1. 取近 60 個交易日（以 2026-05-21 為 anchor）
 *   2. 每天每檔跑「六條件 + 戒律」找出舊 Step 1 候選
 *   3. 對候選跑 evaluateElimination → 算 hard gate 後剩多少
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/measure-elimination-impact.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { BASE_THRESHOLDS } from '@/lib/strategy/StrategyConfig';
import type { CandleWithIndicators } from '@/types';

const ANCHOR_DATE = '2026-05-21';
const WINDOW_TRADING_DAYS = 60;

interface DayResult {
  date: string;
  market: 'TW' | 'CN';
  totalScanned: number;
  passSixCond: number;
  passProhib: number;
  passElim: number;
  shrinkagePct: number;
  ruleHits: Record<string, number>;
}

function loadCandles(file: string): { date: string; open: number; high: number; low: number; close: number; volume: number }[] | null {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d.candles ?? null;
  } catch {
    return null;
  }
}

function getTradingDays(market: 'TW' | 'CN', anchor: string, n: number): string[] {
  // 用市值最大的代表股拉出最近 n 個交易日
  const ref = market === 'TW' ? '2330.TW' : '600519.SS';
  const file = path.join(process.cwd(), 'data', 'candles', market, `${ref}.json`);
  const candles = loadCandles(file);
  if (!candles) return [];
  const idx = candles.findIndex(c => c.date === anchor);
  if (idx < 0) return candles.slice(-n).map(c => c.date);
  return candles.slice(Math.max(0, idx - n + 1), idx + 1).map(c => c.date);
}

function listSymbols(market: 'TW' | 'CN'): string[] {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}

function analyzeMarket(market: 'TW' | 'CN'): DayResult[] {
  const tradingDays = getTradingDays(market, ANCHOR_DATE, WINDOW_TRADING_DAYS);
  if (!tradingDays.length) return [];
  const symbols = listSymbols(market);
  process.stdout.write(`\n[${market}] ${tradingDays.length} 個交易日 × ${symbols.length} 檔\n`);

  // 預載入所有 candles + 指標（一次）
  const symbolCandles = new Map<string, CandleWithIndicators[]>();
  for (const sym of symbols) {
    const raw = loadCandles(path.join(process.cwd(), 'data', 'candles', market, `${sym}.json`));
    if (!raw || raw.length < 60) continue;
    try {
      symbolCandles.set(sym, computeIndicators(raw) as CandleWithIndicators[]);
    } catch { /* skip broken */ }
  }
  process.stdout.write(`  已載入並計算指標：${symbolCandles.size} 檔\n`);

  const results: DayResult[] = [];

  for (const date of tradingDays) {
    let totalScanned = 0;
    let passSixCond = 0;
    let passProhib = 0;
    let passElim = 0;
    const ruleHits: Record<string, number> = {};

    for (const [, candles] of symbolCandles) {
      const idx = candles.findIndex(c => c.date === date);
      if (idx < 60) continue;  // 需要 60 根做指標 + 淘汰判斷
      totalScanned++;

      try {
        // 六條件
        const six = evaluateSixConditions(candles, idx);
        if (six.totalScore < BASE_THRESHOLDS.minScore) continue;
        passSixCond++;

        // 戒律
        const prohib = checkLongProhibitions(candles, idx);
        if (prohib.prohibited) continue;
        passProhib++;

        // 淘汰法
        const elim = evaluateElimination(candles, idx);
        if (elim.eliminated) {
          for (const reason of elim.reasons) {
            const tag = reason.match(/淘汰\d+/)?.[0] ?? 'unknown';
            ruleHits[tag] = (ruleHits[tag] ?? 0) + 1;
          }
          continue;
        }
        passElim++;
      } catch { /* skip */ }
    }

    const shrinkagePct = passProhib > 0
      ? +((passProhib - passElim) / passProhib * 100).toFixed(1)
      : 0;

    results.push({
      date, market, totalScanned,
      passSixCond, passProhib, passElim,
      shrinkagePct, ruleHits,
    });
  }

  return results;
}

function formatReport(allResults: DayResult[]): string {
  const lines: string[] = [];
  lines.push('# 淘汰法 Hard Gate 回滾影響分析');
  lines.push('');
  lines.push(`Anchor: ${ANCHOR_DATE}（取近 ${WINDOW_TRADING_DAYS} 個交易日）`);
  lines.push('');

  for (const market of ['TW', 'CN'] as const) {
    const rs = allResults.filter(r => r.market === market);
    if (!rs.length) continue;

    lines.push(`## ${market} 市場`);
    lines.push('');

    // 彙總
    const avgPassProhib = rs.reduce((s, r) => s + r.passProhib, 0) / rs.length;
    const avgPassElim = rs.reduce((s, r) => s + r.passElim, 0) / rs.length;
    const avgShrinkage = rs.reduce((s, r) => s + r.shrinkagePct, 0) / rs.length;
    const maxShrinkage = Math.max(...rs.map(r => r.shrinkagePct));
    const minShrinkage = Math.min(...rs.map(r => r.shrinkagePct));

    lines.push(`- 平均 Step 1 池（過六條件+戒律）：${avgPassProhib.toFixed(1)} 檔/日`);
    lines.push(`- 平均加 hard gate 後：${avgPassElim.toFixed(1)} 檔/日`);
    lines.push(`- 平均縮小：**${avgShrinkage.toFixed(1)}%**（範圍 ${minShrinkage.toFixed(1)}% – ${maxShrinkage.toFixed(1)}%）`);
    lines.push('');

    // 規則熱點
    const ruleTotals: Record<string, number> = {};
    for (const r of rs) {
      for (const [tag, n] of Object.entries(r.ruleHits)) {
        ruleTotals[tag] = (ruleTotals[tag] ?? 0) + n;
      }
    }
    const sorted = Object.entries(ruleTotals).sort((a, b) => b[1] - a[1]);
    lines.push('### 淘汰規則命中次數（總和）');
    for (const [tag, n] of sorted) {
      lines.push(`- ${tag}: ${n} 次`);
    }
    lines.push('');

    // 日明細
    lines.push('### 日明細');
    lines.push('| 日期 | 過六條件 | 過戒律 | 過淘汰 | 縮小% | 熱點規則 |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of rs) {
      const top = Object.entries(r.ruleHits).sort((a, b) => b[1] - a[1])[0];
      const topStr = top ? `${top[0]}(${top[1]})` : '-';
      lines.push(`| ${r.date} | ${r.passSixCond} | ${r.passProhib} | ${r.passElim} | ${r.shrinkagePct}% | ${topStr} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const tw = analyzeMarket('TW');
  const cn = analyzeMarket('CN');
  const all = [...tw, ...cn];

  const report = formatReport(all);
  const outDir = path.join(process.cwd(), 'docs', 'audit');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, '2026-05-22-elimination-hard-gate-impact.md');
  fs.writeFileSync(outFile, report, 'utf8');

  process.stdout.write(`\n寫入：${outFile}\n`);
  process.stdout.write('\n=== 摘要 ===\n');
  for (const market of ['TW', 'CN'] as const) {
    const rs = all.filter(r => r.market === market);
    if (!rs.length) continue;
    const avg = rs.reduce((s, r) => s + r.shrinkagePct, 0) / rs.length;
    const avgPool = rs.reduce((s, r) => s + r.passProhib, 0) / rs.length;
    const avgAfter = rs.reduce((s, r) => s + r.passElim, 0) / rs.length;
    process.stdout.write(`${market}: 池子 ${avgPool.toFixed(1)} → ${avgAfter.toFixed(1)}（縮小 ${avg.toFixed(1)}%）\n`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
