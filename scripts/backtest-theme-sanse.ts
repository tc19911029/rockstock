/**
 * 題材熱度 × 三色策略 — 三組對照 walk-forward 回測。
 *
 * 用法：npx tsx scripts/backtest-theme-sanse.ts [TW|CN] [days=60] [topThemes=8]
 *
 * 每個決策日 D（只用 ≤D 資料：scanXxx({asOfDate:D}) + 題材熱度 D）→ 選出三組
 * （cross / theme-only / sanse-only）→ 隔日開盤進場 → 前瞻 D1..D20 報酬（超額 vs 指數）。
 * 只掃「之後還有 ≥20 個交易日」的 D，確保 d20 可量測。報酬不持久化、即時 derive。
 *
 * 回答：交叉(cross) 是否比單看題材(theme) 或單看三色(sanse) 勝率更高 / 平均漲幅更好 /
 * 回撤更小。CN 深歷史走漲停池重建行業熱度（近似、印 degraded 占比佐證）。
 */
import { computeEventReturns } from '@/lib/backtest/eventReturns';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { loadIndexCandles, loadStockCandles, ymd8 } from '@/lib/theme-sanse/candles';
import { eventsFromSelection, selectForDate } from '@/lib/theme-sanse/events';
import { aggregateCohort, type ThemeSanseEventWithReturns } from '@/lib/theme-sanse/stats';
import { DEFAULT_CROSS_THRESHOLDS, type Cohort, type TsMarket } from '@/lib/theme-sanse/types';

const FORWARD_TD = 20; // 保留 20 個交易日 tail，確保 d20 可量測

function fmt(x: number | null, suffix = ''): string {
  return x == null ? '  —  ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}${suffix}`;
}

async function main() {
  const market = (process.argv[2] ?? 'TW').toUpperCase() as TsMarket;
  const days = Number(process.argv[3] ?? 60);
  const topThemes = Number(process.argv[4] ?? DEFAULT_CROSS_THRESHOLDS.topThemes);
  const thresholds = { ...DEFAULT_CROSS_THRESHOLDS, topThemes };
  if (market !== 'TW' && market !== 'CN') throw new Error(`market 要 TW|CN，得到 ${market}`);

  const index = await loadIndexCandles(market);
  if (!index || index.length === 0) throw new Error(`找不到 ${market} 指數 K 線`);
  const allDates = index.map((c) => c.date);
  // 只掃「之後還有 ≥FORWARD_TD 交易日」的 D
  const scorable = allDates.slice(0, Math.max(0, allDates.length - FORWARD_TD));
  const window = scorable.slice(-days);
  if (window.length === 0) throw new Error('回測窗為空（資料不足）');

  console.log(`\n=== 題材×三色 三組對照回測 ${market} ===`);
  console.log(`決策日 ${window[0]} → ${window[window.length - 1]}（${window.length} 日，topThemes=${topThemes}）\n`);

  const todayYmd8 = ymd8(new Date().toISOString().slice(0, 10));
  const candleMemo = new Map<string, BaselineCandle[] | null>();
  const collected: Record<Cohort, ThemeSanseEventWithReturns[]> = { cross: [], theme: [], sanse: [] };
  let crossTotal = 0;
  let crossDegraded = 0;

  for (let i = 0; i < window.length; i++) {
    const D = window[i];
    let sel;
    try {
      sel = await selectForDate(market, D, { thresholds });
    } catch (err) {
      console.log(`  ${D} 跳過（${err instanceof Error ? err.message : err}）`);
      continue;
    }
    const degradedThemeIds = new Set(sel.hotThemes.filter((t) => t.degraded).map((t) => t.id));
    const file = eventsFromSelection(market, D, sel.selection, thresholds, new Date().toISOString());
    for (const e of file.events) {
      let candles = candleMemo.get(e.symbol);
      if (candles === undefined) {
        candles = await loadStockCandles(market, e.symbol, todayYmd8);
        candleMemo.set(e.symbol, candles);
      }
      const baseline = settleBaseline(D, candles, new Date().toISOString());
      const returns = baseline.status === 'filled' ? computeEventReturns({ baseline }, candles, index) : null;
      collected[e.cohort].push({ ...e, baseline, returns });
      if (e.cohort === 'cross') {
        crossTotal++;
        if (e.themeIds.some((id) => degradedThemeIds.has(id))) crossDegraded++;
      }
    }
    if ((i + 1) % 10 === 0 || i === window.length - 1) {
      process.stdout.write(`\r  進度 ${i + 1}/${window.length}（cross ${collected.cross.length} / theme ${collected.theme.length} / sanse ${collected.sanse.length}）`);
    }
  }
  console.log('\n');

  const stats = {
    cross: aggregateCohort('cross', collected.cross),
    theme: aggregateCohort('theme', collected.theme),
    sanse: aggregateCohort('sanse', collected.sanse),
  };

  const row = (label: string, s: ReturnType<typeof aggregateCohort>) =>
    `${label.padEnd(14)} n=${String(s.n).padStart(5)} 有效=${String(s.filled).padStart(5)}  ` +
    `勝率d1 ${fmt(s.winRate.d1)} d5 ${fmt(s.winRate.d5)}  ` +
    `平均d1 ${fmt(s.avg.d1, '%')} d5 ${fmt(s.avg.d5, '%')} d20 ${fmt(s.avg.d20, '%')}  ` +
    `中位d5 ${fmt(s.median.d5, '%')}  最大利 ${fmt(s.maxGain, '%')} 回撤 ${fmt(s.maxDrawdown, '%')}  ` +
    `賺賠 ${fmt(s.profitFactor)}  超額d5 ${fmt(s.excessAvg, '%')}${s.lowSample ? '  ⚠樣本少' : ''}`;

  console.log(row('③ 交叉 cross', stats.cross));
  console.log(row('① 只看題材', stats.theme));
  console.log(row('② 只看三色', stats.sanse));
  console.log('');
  if (market === 'CN') {
    const share = crossTotal > 0 ? ((crossDegraded / crossTotal) * 100).toFixed(0) : '0';
    console.log(`⚠ CN：cross 事件中 ${share}% 的題材熱度來自漲停池重建（degraded、近似）— 線上即時熱度 blend 不同，此回測僅佐證。`);
  }

  // 結論：cross d5 平均 / 勝率 是否同時優於 theme 與 sanse
  const better = (a: number | null, b: number | null, c: number | null) =>
    a != null && b != null && c != null && a > b && a > c;
  const winBetter = better(stats.cross.winRate.d5, stats.theme.winRate.d5, stats.sanse.winRate.d5);
  const avgBetter = better(stats.cross.avg.d5, stats.theme.avg.d5, stats.sanse.avg.d5);
  console.log(
    `\n結論（D5）：交叉 ${winBetter && avgBetter ? '✅ 勝率與平均漲幅都勝出' : winBetter ? '勝率勝出、平均未必' : avgBetter ? '平均勝出、勝率未必' : '未明顯勝出'}` +
      `（cross 勝率 ${fmt(stats.cross.winRate.d5)} / 平均 ${fmt(stats.cross.avg.d5, '%')}）`,
  );

  const out = { market, generatedAt: new Date().toISOString(), window: { from: window[0], to: window[window.length - 1], days: window.length }, topThemes, stats, crossDegradedShare: crossTotal > 0 ? crossDegraded / crossTotal : null };
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const dir = path.join(process.cwd(), 'data', 'theme-sanse', market, 'backtest');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(dir, `${stamp}.json`);
  await fs.writeFile(file, JSON.stringify(out, null, 2));
  console.log(`\n報告已存 ${path.relative(process.cwd(), file)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
