/**
 * 題材熱度「排序版」回測 — 三色票按當日題材熱度分段，看報酬是否照熱度遞減。
 *
 * 用法：npx tsx scripts/backtest-theme-sanse-rank.ts [TW|CN] [days=120]
 *
 * 跟「篩選版」(backtest-theme-sanse.ts) 不同：這裡**不丟票**，把三色全部選出的票
 * 按「所屬最熱題材的熱度名次」分三段：
 *   前段 = 熱度#1-8（最熱題材成分）
 *   中段 = 熱度#9-20
 *   後段 = >#20 或不在任何排名題材（冷/無題材）
 * 若報酬「前段 > 中段 > 後段」單調遞減 → 證明「按熱點排序、看前面」有意義。
 *
 * 選股只用 ≤D 資料、隔日開盤進場、報酬即時 derive（防前視）。
 */
import { computeEventReturns } from '@/lib/backtest/eventReturns';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { loadIndexCandles, loadStockCandles, ymd8 } from '@/lib/theme-sanse/candles';
import { invertHotThemes } from '@/lib/theme-sanse/codeThemes';
import { selectForDate } from '@/lib/theme-sanse/events';
import { aggregateCohort, type ThemeSanseEventWithReturns } from '@/lib/theme-sanse/stats';
import type { TsMarket } from '@/lib/theme-sanse/types';

const FORWARD_TD = 20;
type Tier = '前段(熱#1-8)' | '中段(熱#9-20)' | '後段/無題材' | '三色全體';
const TIERS: Tier[] = ['前段(熱#1-8)', '中段(熱#9-20)', '後段/無題材', '三色全體'];

const tierOf = (hr: number): Tier => (hr <= 8 ? '前段(熱#1-8)' : hr <= 20 ? '中段(熱#9-20)' : '後段/無題材');
const fmt = (x: number | null, s = '') => (x == null ? '  —  ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}${s}`);

async function main() {
  const market = (process.argv[2] ?? 'TW').toUpperCase() as TsMarket;
  const days = Number(process.argv[3] ?? 120);
  if (market !== 'TW' && market !== 'CN') throw new Error(`market 要 TW|CN`);

  const index = await loadIndexCandles(market);
  if (!index?.length) throw new Error(`找不到 ${market} 指數 K 線`);
  const allDates = index.map((c) => c.date);
  const window = allDates.slice(0, Math.max(0, allDates.length - FORWARD_TD)).slice(-days);
  if (!window.length) throw new Error('回測窗為空');

  console.log(`\n=== 題材熱度「排序版」回測 ${market} ===`);
  console.log(`三色票按所屬最熱題材名次分段。決策日 ${window[0]} → ${window[window.length - 1]}（${window.length} 日）\n`);

  const todayYmd8 = ymd8(new Date().toISOString().slice(0, 10));
  const memo = new Map<string, BaselineCandle[] | null>();
  const buckets: Record<Tier, ThemeSanseEventWithReturns[]> = {
    '前段(熱#1-8)': [], '中段(熱#9-20)': [], '後段/無題材': [], '三色全體': [],
  };

  for (let i = 0; i < window.length; i++) {
    const D = window[i];
    let sel;
    try {
      sel = await selectForDate(market, D);
    } catch (e) {
      console.log(`  ${D} 跳過（${e instanceof Error ? e.message : e}）`);
      continue;
    }
    const codeToThemes = invertHotThemes(sel.hotThemes);
    for (const c of sel.selection.sanse) {
      const refs = codeToThemes.get(c.code) ?? [];
      const heatRank = refs.length ? Math.min(...refs.map((r) => r.heatRank)) : Infinity;
      let candles = memo.get(c.symbol);
      if (candles === undefined) {
        candles = await loadStockCandles(market, c.symbol, todayYmd8);
        memo.set(c.symbol, candles);
      }
      const baseline = settleBaseline(D, candles, new Date().toISOString());
      const returns = baseline.status === 'filled' ? computeEventReturns({ baseline }, candles, index) : null;
      // aggregateCohort 只讀 .baseline / .returns；其餘欄位給最小佔位
      const ev = { baseline, returns } as unknown as ThemeSanseEventWithReturns;
      buckets[tierOf(heatRank)].push(ev);
      buckets['三色全體'].push(ev);
    }
    if ((i + 1) % 10 === 0 || i === window.length - 1) {
      process.stdout.write(`\r  進度 ${i + 1}/${window.length}（全體 ${buckets['三色全體'].length}）`);
    }
  }
  console.log('\n');

  const stats = Object.fromEntries(TIERS.map((t) => [t, aggregateCohort('sanse', buckets[t])])) as Record<Tier, ReturnType<typeof aggregateCohort>>;
  for (const t of TIERS) {
    const s = stats[t];
    console.log(
      `${t.padEnd(14)} n=${String(s.n).padStart(5)} 有效=${String(s.filled).padStart(5)}  ` +
      `勝率d5 ${fmt(s.winRate.d5)}  平均d1 ${fmt(s.avg.d1, '%')} d5 ${fmt(s.avg.d5, '%')} d20 ${fmt(s.avg.d20, '%')}  ` +
      `中位d5 ${fmt(s.median.d5, '%')}  賺賠 ${fmt(s.profitFactor)}  超額d5 ${fmt(s.excessAvg, '%')}${s.lowSample ? ' ⚠樣本少' : ''}`,
    );
  }

  const a = stats['前段(熱#1-8)'].avg.d5;
  const b = stats['中段(熱#9-20)'].avg.d5;
  const c = stats['後段/無題材'].avg.d5;
  const mono = a != null && b != null && c != null && a > b && b > c;
  const frontBeatsAll = a != null && stats['三色全體'].avg.d5 != null && a > stats['三色全體'].avg.d5;
  console.log(
    `\n結論（D5 平均）：${mono ? '✅ 前段>中段>後段 單調遞減 → 按熱點排序有意義' : frontBeatsAll ? '◐ 非完全單調，但前段贏過三色全體 → 排序有部分價值' : '✗ 沒有照熱點遞減 → 排序對此市場幫助不明顯'}` +
    `（前段 ${fmt(a, '%')} / 全體 ${fmt(stats['三色全體'].avg.d5, '%')} / 後段 ${fmt(c, '%')}）`,
  );

  const path = await import('path');
  const { promises: fs } = await import('fs');
  const dir = path.join(process.cwd(), 'data', 'theme-sanse', market, 'backtest');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  await fs.writeFile(path.join(dir, `rank-${stamp}.json`), JSON.stringify({ market, window: { from: window[0], to: window[window.length - 1] }, stats }, null, 2));
  console.log(`\n報告已存 data/theme-sanse/${market}/backtest/rank-${stamp}.json\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
