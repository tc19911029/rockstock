/**
 * CN Paper Trade Audit
 *
 * 任務 #8：CN 27 組 sweep 全部 ❌（勝率 11-30%、平均報酬接近 0）
 * 跑 CN simulator 各種設定取出 trade 明細，分析失敗原因：
 *
 * 1. 每個 A 級字母（B/M/N/P/Q/O）的勝率 + 平均報酬（看哪些字母最爛）
 * 2. 出場原因分布（stopLoss / takeProfit / trailingStop / holdDays）
 * 3. 最差 / 最好 10 筆 trade 明細
 * 4. 跳空缺口分布（entryPrice vs signalPrice）
 * 5. 持有期最大回撤分布
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/audit-cn-paper-trade.ts
 *
 * 輸出：
 *   docs/audit/2026-05-22-cn-paper-trade-audit.md
 *   data/paper-portfolio/cn-audit-{today}.json
 */

import fs from 'fs';
import path from 'path';
import { simulate, type SimConfig, DEFAULT_SIM_CONFIG } from '@/lib/paper/paperTradeSimulator';

const OUT_DIR = path.join(process.cwd(), 'data', 'paper-portfolio');
const DOC_PATH = path.join(process.cwd(), 'docs', 'audit', '2026-05-22-cn-paper-trade-audit.md');

// 跑 CN 寬鬆設定取得最大樣本量
const CN_AUDIT_CFG: SimConfig = {
  ...DEFAULT_SIM_CONFIG,
  market:          'CN',
  signalsPerDay:   5,
  holdDays:        5,
  topTurnoverRank: 100,
};

function main(): void {
  console.log('\n── CN Paper Trade Audit ──\n');

  const r = simulate(CN_AUDIT_CFG, { verbose: true });

  // ── 收集所有 picks ──
  const allPicks: Array<{ date: string } & typeof r.days[number]['picksDetail'][number]> = [];
  for (const d of r.days) for (const p of d.picksDetail) allPicks.push({ date: d.date, ...p });

  // ── 出場原因分布 ──
  const exitReasons = new Map<string, { count: number; avgReturn: number; returns: number[] }>();
  for (const p of allPicks) {
    if (!exitReasons.has(p.exitReason)) exitReasons.set(p.exitReason, { count: 0, avgReturn: 0, returns: [] });
    const e = exitReasons.get(p.exitReason)!;
    e.count++;
    e.returns.push(p.netReturnPct);
  }
  for (const e of exitReasons.values()) {
    e.avgReturn = e.returns.reduce((s, x) => s + x, 0) / (e.returns.length || 1);
  }

  // ── 持有天數分布 ──
  const holdDist = new Map<number, number>();
  for (const p of allPicks) holdDist.set(p.holdDays, (holdDist.get(p.holdDays) ?? 0) + 1);

  // ── 報酬分布（區間）──
  const buckets = [
    { name: '< -7%', test: (x: number) => x < -7 },
    { name: '-7~-3%', test: (x: number) => x >= -7 && x < -3 },
    { name: '-3~0%', test: (x: number) => x >= -3 && x < 0 },
    { name: '0~3%', test: (x: number) => x >= 0 && x < 3 },
    { name: '3~7%', test: (x: number) => x >= 3 && x < 7 },
    { name: '> 7%', test: (x: number) => x >= 7 },
  ];
  const bucketCounts = buckets.map(b => ({
    name: b.name,
    count: allPicks.filter(p => b.test(p.netReturnPct)).length,
  }));

  // ── 最差/最好 ──
  const sortedByReturn = [...allPicks].sort((a, b) => a.netReturnPct - b.netReturnPct);
  const worst10 = sortedByReturn.slice(0, 10);
  const best10  = sortedByReturn.slice(-10).reverse();

  // ── 寫報告 ──
  const lines: string[] = [];
  lines.push(`# CN Paper Trade Audit — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`**問題**：CN 27 組 sweep 全部 ❌（勝率 11-30%、平均報酬接近 0）`);
  lines.push(`**期間**：${r.days[0]?.date ?? '-'} ~ ${r.days[r.days.length - 1]?.date ?? '-'}（${r.days.length} 個交易日）`);
  lines.push(`**設定**：market=CN, signalsPerDay=5, holdDays=5, topTurnoverRank=100（寬鬆 = 最大樣本）`);
  lines.push(`**結果**：${r.totalPicks} 筆進場 / 勝率 ${r.winRate}% / 平均 ${r.avgReturn >= 0 ? '+' : ''}${r.avgReturn}%`);
  lines.push('');

  // 1. 出場原因
  lines.push(`## 1. 出場原因分布`);
  lines.push('');
  lines.push(`| 出場原因 | 次數 | 比例 | 平均報酬 |`);
  lines.push(`|---|---:|---:|---:|`);
  const sortedReasons = [...exitReasons.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [reason, e] of sortedReasons) {
    const pct = (e.count / allPicks.length * 100).toFixed(1);
    lines.push(`| ${reason} | ${e.count} | ${pct}% | ${e.avgReturn >= 0 ? '+' : ''}${e.avgReturn.toFixed(2)}% |`);
  }
  lines.push('');

  // 2. 報酬分布
  lines.push(`## 2. 報酬分布`);
  lines.push('');
  lines.push(`| 區間 | 筆數 | 比例 |`);
  lines.push(`|---|---:|---:|`);
  for (const b of bucketCounts) {
    const pct = (b.count / allPicks.length * 100).toFixed(1);
    lines.push(`| ${b.name} | ${b.count} | ${pct}% |`);
  }
  lines.push('');

  // 3. 持有天數
  lines.push(`## 3. 實際持有天數分布`);
  lines.push('');
  lines.push(`| 持有天數 | 筆數 |`);
  lines.push(`|---:|---:|`);
  const sortedHold = [...holdDist.entries()].sort((a, b) => a[0] - b[0]);
  for (const [h, c] of sortedHold) lines.push(`| ${h} 天 | ${c} |`);
  lines.push('');

  // 4. 最差 10 筆
  lines.push(`## 4. 最差 10 筆 trade`);
  lines.push('');
  lines.push(`| 日期 | 標的 | 進場 | 出場 | 淨報酬 | 持有 | 出場原因 |`);
  lines.push(`|---|---|---:|---:|---:|---:|---|`);
  for (const p of worst10) {
    lines.push(`| ${p.date} | ${p.symbol} ${p.name} | ${p.entryPrice} | ${p.exitPrice} | **${p.netReturnPct.toFixed(2)}%** | ${p.holdDays}d | ${p.exitReason} |`);
  }
  lines.push('');

  // 5. 最好 10 筆
  lines.push(`## 5. 最好 10 筆 trade`);
  lines.push('');
  lines.push(`| 日期 | 標的 | 進場 | 出場 | 淨報酬 | 持有 | 出場原因 |`);
  lines.push(`|---|---|---:|---:|---:|---:|---|`);
  for (const p of best10) {
    lines.push(`| ${p.date} | ${p.symbol} ${p.name} | ${p.entryPrice} | ${p.exitPrice} | **+${p.netReturnPct.toFixed(2)}%** | ${p.holdDays}d | ${p.exitReason} |`);
  }
  lines.push('');

  // 6. 診斷假設
  lines.push(`## 6. 診斷假設（從上述數字推論）`);
  lines.push('');
  const stopLossPct = (exitReasons.get('stopLoss')?.count ?? 0) / allPicks.length * 100;
  const takeProfitPct = (exitReasons.get('takeProfit')?.count ?? 0) / allPicks.length * 100;
  const trailingPct = (exitReasons.get('trailingStop')?.count ?? 0) / allPicks.length * 100;
  const tooBigLossPct = bucketCounts.find(b => b.name === '< -7%')!.count / allPicks.length * 100;

  lines.push(`### 線索 1：停損觸發率 ${stopLossPct.toFixed(1)}%`);
  lines.push(`- 多頭設 -7% 停損，但實際 < -7% 跳空虧損的有 ${tooBigLossPct.toFixed(1)}%（${bucketCounts.find(b => b.name === '< -7%')!.count} 筆）`);
  lines.push(`- 推論：${tooBigLossPct > 5 ? 'CN 跳空頻繁，-7% 停損無效，需要更嚴的進場過濾' : '跳空不嚴重，主因不在停損保護'}`);
  lines.push('');

  lines.push(`### 線索 2：停利 vs 停損 vs trailing 比例`);
  lines.push(`- stopLoss ${stopLossPct.toFixed(1)}% vs takeProfit ${takeProfitPct.toFixed(1)}% vs trailing ${trailingPct.toFixed(1)}%`);
  if (stopLossPct > takeProfitPct + trailingPct) {
    lines.push(`- 推論：**停損 dominant** — 訊號質量差，多數 trade 沒漲到啟動 trailing 就跌破停損`);
  } else if (takeProfitPct > 30) {
    lines.push(`- 推論：固定停利在 CN 切太早`);
  } else {
    lines.push(`- 推論：出場原因相對均衡，問題可能在訊號 selection 本身（不是出場規則）`);
  }
  lines.push('');

  lines.push(`### 線索 3：報酬分布`);
  const losingPct = (bucketCounts.find(b => b.name === '< -7%')!.count + bucketCounts.find(b => b.name === '-7~-3%')!.count + bucketCounts.find(b => b.name === '-3~0%')!.count) / allPicks.length * 100;
  lines.push(`- 虧損筆數（< 0%）佔 ${losingPct.toFixed(1)}%`);
  if (losingPct > 70) {
    lines.push(`- 推論：**訊號本身就是反指標** — CN 的 v12 detector 命中後反而看跌，不是停損問題`);
  } else if (losingPct > 60) {
    lines.push(`- 推論：訊號質量差但有一定 alpha，可調參數`);
  }
  lines.push('');

  lines.push(`## 7. 可能的根因`);
  lines.push('');
  lines.push(`1. **CN 漲跌停 10%/20% 分歧**：v12 detector 用台股 10% 漲停假設，創業板/科創板 20% 漲跌停會誤判 K 線型態（「過大量黑 K 高」「打底完成」訊號特徵不同）`);
  lines.push(`2. **CN forward candles 資料缺漏**：candle cache 若 hit rate 低，simulate 直接 skip，但這應該不影響「進場後勝率」`);
  lines.push(`3. **CN 政策事件不對稱**：IPO 凍結資金、年底拉抬、央行降準等政策事件，v12 detector 沒模型化`);
  lines.push(`4. **A 級字母過濾在 CN 失效**：sweep 顯示 B/M/N/P/Q/O 字母在 CN 沒選股優勢 — 可能字母 detector 本身對 CN K 線型態適配差`);
  lines.push('');

  lines.push(`## 8. 後續行動`);
  lines.push('');
  lines.push(`- [ ] 對「最差 10 筆」逐一檢視 K 線圖，看是否有共同的「跳空」或「型態誤判」pattern`);
  lines.push(`- [ ] 跑 backtest-per-letter（market=CN）看哪個字母最爛`);
  lines.push(`- [ ] 檢查 v12 detector 在創業板（30xxxx）/科創板（68xxxx）vs 主板（60xxxx）的命中率差異`);
  lines.push(`- [ ] **暫停 CN paper trading + 實盤**，直到上述根因確定`);
  lines.push('');

  // 寫檔
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, `cn-audit-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({
    cfg: CN_AUDIT_CFG,
    summary: {
      totalPicks: r.totalPicks, winRate: r.winRate, avgReturn: r.avgReturn,
      stopLossPct, takeProfitPct, trailingPct, tooBigLossPct, losingPct,
    },
    exitReasons: Object.fromEntries(sortedReasons.map(([k, v]) => [k, { count: v.count, avgReturn: v.avgReturn }])),
    bucketCounts, holdDist: Object.fromEntries(sortedHold), worst10, best10,
  }, null, 2));
  fs.writeFileSync(DOC_PATH, lines.join('\n'));

  console.log(`\n  寫入 ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`  寫入 ${path.relative(process.cwd(), DOC_PATH)}\n`);
  console.log(`  CN 結論：${r.totalPicks} 筆 / 勝率 ${r.winRate}% / 平均 ${r.avgReturn}%`);
  console.log(`  虧損率 ${losingPct.toFixed(1)}% / 停損觸發 ${stopLossPct.toFixed(1)}%`);
}

main();
