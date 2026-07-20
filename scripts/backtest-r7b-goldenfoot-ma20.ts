/**
 * 驗證 3：goldenRightFoot 補課程圖形四的「第二支腳在月線之上 + 月線上揚」
 *
 * 現況 lib/rules/bottomFormationRules.ts:54-106 五個條件，無 close>ma20、無 ma20 上揚。
 * 課程 5-4/p07：「當第二支腳的出現位置在月線之上，大量長紅上漲，月線上揚，開始做短多或長多」
 *
 * ⚠️ 落點已查明（2026-07-20）：goldenRightFoot 只註冊在 ruleRegistry「zhu-advanced」，
 * MarketScanner 於「第二層：排序資料收集」呼叫 ruleEngine，其輸出只進 triggeredRules
 * 顯示欄位，全 repo 無任何 filter/sort 讀它 → **顯示層，不是 gate**。
 * 故本測是「訊號品質是否改善」，不是「選股門檻該不該加」。
 *
 * 條件實作：
 *   MA20A  = 訊號日 close > ma20（第二支腳/突破日在月線之上）
 *   MA20R  = ma20[idx] > ma20[idx-5]（月線上揚）
 *   BOTH   = MA20A && MA20R  ← 課程原文
 */
import { goldenRightFoot } from '@/lib/rules/bottomFormationRules';
import {
  loadStocks, loadBench, benchFwd, liquid, HORIZONS,
  type Obs, reportGroup, splitDate, mean, attachUniverseExcess,
} from './backtest-r7b-common';

function main() {
  const bench = loadBench();
  const stocks = loadStocks();
  const FROM = '2023-04-13';
  const all: (Obs & { above: boolean; rising: boolean })[] = [];
  const universe: Obs[] = [];

  let done = 0;
  for (const s of stocks) {
    const cs = s.candles;
    for (let t = 60; t + 20 < cs.length; t++) {
      const c = cs[t];
      if (c.date < FROM) continue;
      if (!liquid(c)) continue;

      const ex: Record<number, number> = {};
      let ok = true;
      for (const h of HORIZONS) {
        const b = benchFwd(bench, c.date, h);
        if (b == null) { ok = false; break; }
        ex[h] = (cs[t + h].close / c.close - 1) * 100 - b;
      }
      if (!ok) continue;
      universe.push({ date: c.date, symbol: s.symbol, ex });

      // 便宜前置：goldenRightFoot 必為長紅突破
      if (c.close <= c.open) continue;

      const sig = goldenRightFoot.evaluate(cs, t);
      if (!sig || sig.type !== 'BUY') continue;

      const ma20 = c.ma20;
      const ma20prev = cs[t - 5]?.ma20;
      if (ma20 == null || ma20prev == null) continue;
      all.push({
        date: c.date, symbol: s.symbol, ex,
        above: c.close > ma20,
        rising: ma20 > ma20prev,
      });
    }
    if (++done % 300 === 0) process.stdout.write('.');
  }
  console.log('');
  attachUniverseExcess(universe, [universe, all]);

  console.log(`\n===== 驗證 3：goldenRightFoot 補「月線之上 + 月線上揚」=====`);
  console.log(`⚠️ 落點：顯示層（ruleEngine triggeredRules），非選股 gate`);
  console.log(`生產 goldenRightFoot 訊號共 ${all.length} 筆`);
  if (all.length < 20) { console.log('樣本過少，無法判定'); return; }
  const mid = splitDate(all);
  console.log(`train/test 分界 ${mid}`);

  reportGroup('現況全體（無 MA20 條件）', all, mid);

  const variants: [string, (o: typeof all[number]) => boolean][] = [
    ['MA20A 收盤在月線之上', o => o.above],
    ['MA20R 月線上揚', o => o.rising],
    ['BOTH 課程原文（兩者皆要）', o => o.above && o.rising],
  ];
  for (const [name, pred] of variants) {
    const keep = all.filter(pred);
    const cut = all.filter(o => !pred(o));
    console.log(`\n########## ${name} ##########`);
    reportGroup('留下', keep, mid);
    reportGroup('被砍', cut, mid);
    if (keep.length && all.length) {
      const d5 = mean(keep.map(o => o.exu![5])) - mean(all.map(o => o.exu![5]));
      const d20 = mean(keep.map(o => o.exu![20])) - mean(all.map(o => o.exu![20]));
      console.log(`  留下 vs 現況全體：D5 ${d5.toFixed(2)}pp  D20 ${d20.toFixed(2)}pp（正=有改善）`);
    }
  }
  console.log('\n判讀：「被砍」組 train/test 都明顯較差 + 「留下」組優於現況全體 → 通過。');
}
main();
