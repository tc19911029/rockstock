/**
 * 三色「戰法 × 熱點」細格回測 — 找最佳搭配。
 *
 * 用法：npx tsx scripts/backtest-theme-sanse-combo.ts [TW|CN] [days=120]
 *
 * 對每日全部三色 records：
 *   - 判定它命中哪些「具名戰法」(底反/全共振/紅+黃+觸發/紅+雙B金叉/紅+雙B金叉或突破)
 *   - 判定它的 combo 等級 (top/prime/mid/watch/weak)
 *   - 判定它所屬最熱題材的熱點段 (前段#1-8 / 中段#9-20 / 後段冷或無題材)
 * 然後「戰法 × 熱點段」「等級 × 熱點段」交叉統計前瞻報酬，找最會漲的搭配。
 * 隔日開盤進場、報酬即時 derive、防前視（選股只用 ≤D 資料）。
 *
 * 一檔可命中多個戰法（UI 是選單一戰法 → 各戰法獨立統計，重疊正常）。
 */
import { computeEventReturns } from '@/lib/backtest/eventReturns';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { COMBO_LABEL, type ComboGrade } from '@/lib/cn-sanse/conditions';
import { NAMED_STRATEGIES, matchedStrategies } from '@/lib/cn-sanse/namedStrategies';
import { scanSanSe, type ResonanceRecord } from '@/lib/cn-sanse/scan';
import { loadSanSeScan } from '@/lib/cn-sanse/scanStorage';
import { scanTwSanSe } from '@/lib/tw-sanse/scan';
import { loadTwSanSeScan } from '@/lib/tw-sanse/scanStorage';
import { loadIndexCandles, loadStockCandles, ymd8 } from '@/lib/theme-sanse/candles';
import { invertHotThemes } from '@/lib/theme-sanse/codeThemes';
import { rankHotThemes } from '@/lib/theme-sanse/hotThemes';
import { aggregateCohort, type ThemeSanseEventWithReturns } from '@/lib/theme-sanse/stats';
import type { TsMarket } from '@/lib/theme-sanse/types';

const FORWARD_TD = 20;
type HeatTier = '前' | '中' | '後';
const HEAT_TIERS: HeatTier[] = ['前', '中', '後'];
const stripSuffix = (s: string) => s.replace(/\.(TW|TWO|SS|SZ)$/i, '');
const tierOf = (hr: number): HeatTier => (hr <= 8 ? '前' : hr <= 20 ? '中' : '後');
const fmt = (x: number | null, s = '') => (x == null ? '  — ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}${s}`);

const GRADES: ComboGrade[] = ['top', 'prime', 'mid', 'watch', 'weak'];

async function loadRecords(market: TsMarket, date: string): Promise<{ records: ResonanceRecord[] }> {
  const saved = market === 'TW' ? await loadTwSanSeScan(date) : await loadSanSeScan(date);
  if (saved && saved.lastDate === date && saved.records?.length) return { records: saved.records };
  const scan = market === 'TW' ? await scanTwSanSe({ asOfDate: date }) : await scanSanSe({ asOfDate: date });
  return { records: scan.records };
}

async function main() {
  const market = (process.argv[2] ?? 'TW').toUpperCase() as TsMarket;
  const days = Number(process.argv[3] ?? 120);
  if (market !== 'TW' && market !== 'CN') throw new Error('market 要 TW|CN');

  const index = await loadIndexCandles(market);
  if (!index?.length) throw new Error(`找不到 ${market} 指數 K 線`);
  const allDates = index.map((c) => c.date);
  const window = allDates.slice(0, Math.max(0, allDates.length - FORWARD_TD)).slice(-days);
  if (!window.length) throw new Error('回測窗為空');

  console.log(`\n========== 三色「戰法 × 熱點」細格回測 ${market} ==========`);
  console.log(`決策日 ${window[0]} → ${window[window.length - 1]}（${window.length} 日）。熱點段：前=題材#1-8 / 中=#9-20 / 後=冷或無題材。\n`);

  const todayYmd8 = ymd8(new Date().toISOString().slice(0, 10));
  const memo = new Map<string, BaselineCandle[] | null>();
  // key = `${dim}|${bucket}|${tier|ALL}` → events
  const buckets = new Map<string, ThemeSanseEventWithReturns[]>();
  const push = (key: string, ev: ThemeSanseEventWithReturns) => {
    const arr = buckets.get(key) ?? [];
    arr.push(ev);
    buckets.set(key, arr);
  };

  for (let i = 0; i < window.length; i++) {
    const D = window[i];
    let records: ResonanceRecord[];
    let codeToThemes: Map<string, { heatRank: number }[]>;
    try {
      const hot = await rankHotThemes(market, D);
      codeToThemes = invertHotThemes(hot);
      ({ records } = await loadRecords(market, D));
    } catch (e) {
      console.log(`  ${D} 跳過（${e instanceof Error ? e.message : e}）`);
      continue;
    }
    for (const rec of records) {
      const refs = codeToThemes.get(stripSuffix(rec.symbol)) ?? [];
      const heatRank = refs.length ? Math.min(...refs.map((r) => r.heatRank)) : Infinity;
      const tier = tierOf(heatRank);
      let candles = memo.get(rec.symbol);
      if (candles === undefined) {
        candles = await loadStockCandles(market, rec.symbol, todayYmd8);
        memo.set(rec.symbol, candles);
      }
      const baseline = settleBaseline(D, candles, new Date().toISOString());
      const returns = baseline.status === 'filled' ? computeEventReturns({ baseline }, candles, index) : null;
      const ev = { baseline, returns } as unknown as ThemeSanseEventWithReturns;

      for (const sid of matchedStrategies(rec.report).map((s) => s.id)) {
        push(`strat|${sid}|${tier}`, ev);
        push(`strat|${sid}|ALL`, ev);
      }
      const grade = rec.report.combo?.grade;
      if (grade) {
        push(`grade|${grade}|${tier}`, ev);
        push(`grade|${grade}|ALL`, ev);
      }
    }
    if ((i + 1) % 20 === 0 || i === window.length - 1) {
      process.stdout.write(`\r  進度 ${i + 1}/${window.length}`);
    }
  }
  console.log('\n');

  const cell = (key: string) => aggregateCohort('sanse', buckets.get(key) ?? []);
  const line = (label: string, key: string) => {
    const s = cell(key);
    if (s.n === 0) return `  ${label.padEnd(20)} （無）`;
    return `  ${label.padEnd(20)} n=${String(s.n).padStart(5)} 有效=${String(s.filled).padStart(5)}  勝率d5 ${fmt(s.winRate.d5)}  平均d5 ${fmt(s.avg.d5, '%')}  d20 ${fmt(s.avg.d20, '%')}  賺賠 ${fmt(s.profitFactor)}${s.lowSample ? ' ⚠少' : ''}`;
  };

  console.log('—— 具名戰法 × 熱點段（前段=在最熱題材；看「前段」是否優於「後段」「全體ALL」）——');
  for (const st of NAMED_STRATEGIES) {
    console.log(`【${st.label}】`);
    for (const t of HEAT_TIERS) console.log(line(`　熱點${t}段`, `strat|${st.id}|${t}`));
    console.log(line('　全體(不分熱點)', `strat|${st.id}|ALL`));
  }

  console.log('\n—— combo 等級 × 熱點段 ——');
  for (const g of GRADES) {
    const any = HEAT_TIERS.some((t) => (buckets.get(`grade|${g}|${t}`)?.length ?? 0) > 0);
    if (!any) continue;
    console.log(`【${COMBO_LABEL[g]}】`);
    for (const t of HEAT_TIERS) console.log(line(`　熱點${t}段`, `grade|${g}|${t}`));
    console.log(line('　全體(不分熱點)', `grade|${g}|ALL`));
  }

  // 找最佳搭配（戰法×前段，d20 平均最高、樣本足）
  const candidates = NAMED_STRATEGIES.map((st) => ({ st, s: cell(`strat|${st.id}|前`) }))
    .filter((c) => c.s.filled >= 20 && c.s.avg.d20 != null)
    .sort((a, b) => (b.s.avg.d20 ?? -Infinity) - (a.s.avg.d20 ?? -Infinity));
  console.log('\n—— 最佳搭配（戰法 + 熱點前段，樣本≥20，按 D20 平均）——');
  if (candidates.length === 0) console.log('  （前段樣本都太少，無法下結論）');
  else candidates.slice(0, 3).forEach((c, i) => console.log(`  ${i + 1}. ${c.st.label} × 熱點前段：d5 ${fmt(c.s.avg.d5, '%')} / d20 ${fmt(c.s.avg.d20, '%')} / 賺賠 ${fmt(c.s.profitFactor)} (有效 ${c.s.filled})`));

  const path = await import('path');
  const { promises: fs } = await import('fs');
  const dir = path.join(process.cwd(), 'data', 'theme-sanse', market, 'backtest');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dump: Record<string, unknown> = {};
  for (const [k, v] of buckets) dump[k] = aggregateCohort('sanse', v);
  await fs.writeFile(path.join(dir, `combo-${stamp}.json`), JSON.stringify({ market, window: { from: window[0], to: window[window.length - 1] }, cells: dump }, null, 2));
  console.log(`\n報告已存 data/theme-sanse/${market}/backtest/combo-${stamp}.json\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
