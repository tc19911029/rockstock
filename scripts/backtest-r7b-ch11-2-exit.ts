/**
 * 驗證 4：CH11-2「連漲 3 天且漲幅 >10% → K 線戰法停利」
 *
 * 現況 lib/sell/v12TakeProfit.ts:107-116：只看 profitPct ≥ 0.20 → advisory 切 MA5，
 * 完全不看連漲天數。
 * 課程 CH11-2/p05：「連續上漲超過 3 天，漲幅超過 10%，採取 K 線戰法停利」；
 * 逐字稿：「第三天第四天黑K跌破昨天的低點，我就賣了，不一定有跌破五均」。
 *
 * 這是出場側 → 判定標準是「賠少」（期望值 / 最大回撤 / 下檔尾巴），不是 alpha。
 *
 * 事件 = 觸發日（連漲 ≥3 天 且 3 日累計漲幅 >10%）。兩種政策在觸發日之前完全相同，
 * 故一律從「觸發日收盤」起算報酬，這樣比較才公平。
 *
 * 進場參考價假設（Policy B 的 20% 開關要有基準）：
 *   refPrice = 連漲起算前一根的收盤（即這段 3+ 天漲勢的起點）。已於輸出標明。
 *
 * 政策：
 *   A-course  課程 K 線戰法：出現「黑K 且 跌破昨日最低」→ 當日收盤出
 *   A-loose   放寬版：只要「跌破昨日最低」（不要求黑K）→ 當日收盤出
 *   B-current 現行：預設守 MA20（收盤跌破 MA20 出）；一旦自 refPrice 獲利 ≥20% → 改守 MA5
 *   C-hold20  對照：無腦持有 20 個交易日
 * 全部以 60 根為上限；到期未觸發則以第 60 根收盤結算。
 */
import {
  loadStocks, loadBench, benchFwd, liquid, mean, median, splitDate, tStat,
} from './backtest-r7b-common';
import type { CandleWithIndicators } from '@/types';

const MAX_HOLD = 60;

interface Trade {
  date: string;
  symbol: string;
  /** policy → { ret%, days } */
  r: Record<string, { ret: number; days: number }>;
  benchRet: number;
}

type Exit = { ret: number; days: number };

function runPolicy(
  cs: CandleWithIndicators[], t: number, refPrice: number, policy: string,
): Exit {
  const entry = cs[t].close;
  const last = Math.min(t + MAX_HOLD, cs.length - 1);
  for (let i = t + 1; i <= last; i++) {
    const c = cs[i], p = cs[i - 1];
    if (policy === 'A-course') {
      if (c.close < c.open && c.low < p.low) return { ret: (c.close / entry - 1) * 100, days: i - t };
    } else if (policy === 'A-loose') {
      if (c.low < p.low) return { ret: (c.close / entry - 1) * 100, days: i - t };
    } else if (policy === 'B-current') {
      const profitFromRef = refPrice > 0 ? c.close / refPrice - 1 : 0;
      const switched = profitFromRef >= 0.20;
      const ma = switched ? c.ma5 : c.ma20;
      if (ma != null && c.close < ma) return { ret: (c.close / entry - 1) * 100, days: i - t };
    } else if (policy === 'C-hold20') {
      if (i - t >= 20) return { ret: (c.close / entry - 1) * 100, days: i - t };
    }
  }
  return { ret: (cs[last].close / entry - 1) * 100, days: last - t };
}

const POLICIES = ['A-course', 'A-loose', 'B-current', 'C-hold20'] as const;

function stats(rows: Trade[], p: string) {
  const rs = rows.map(r => r.r[p].ret).filter(Number.isFinite);
  if (!rs.length) return null;
  const losers = rs.filter(x => x < 0);
  const winners = rs.filter(x => x > 0);
  const sorted = [...rs].sort((a, b) => a - b);
  const p5 = sorted[Math.floor(sorted.length * 0.05)];
  const grossW = winners.reduce((s, x) => s + x, 0);
  const grossL = Math.abs(losers.reduce((s, x) => s + x, 0));
  return {
    n: rs.length,
    mean: mean(rs),
    med: median(rs),
    win: winners.length / rs.length * 100,
    avgLoss: losers.length ? mean(losers) : 0,
    worst: sorted[0],
    p5,
    pf: grossL > 0 ? grossW / grossL : Infinity,
    days: mean(rows.map(r => r.r[p].days)),
    t: tStat(rs),
  };
}

function table(label: string, rows: Trade[]) {
  console.log(`\n── ${label}（n=${rows.length}）──`);
  if (!rows.length) return;
  console.log('  政策         n     平均報酬  中位數   勝率   平均虧損   最差    P5尾巴   PF     持有天  t值');
  for (const p of POLICIES) {
    const s = stats(rows, p);
    if (!s) continue;
    console.log(
      `  ${p.padEnd(11)} ${String(s.n).padStart(5)}  ` +
      `${s.mean.toFixed(2).padStart(7)}%  ${s.med.toFixed(2).padStart(6)}%  ` +
      `${s.win.toFixed(0).padStart(3)}%  ${s.avgLoss.toFixed(2).padStart(7)}%  ` +
      `${s.worst.toFixed(1).padStart(6)}%  ${s.p5.toFixed(1).padStart(6)}%  ` +
      `${s.pf.toFixed(2).padStart(5)}  ${s.days.toFixed(1).padStart(5)}  ${s.t.toFixed(2).padStart(6)}`,
    );
  }
  const bench = rows.map(r => r.benchRet);
  console.log(`  (同期 ^TWII 20日平均 ${mean(bench).toFixed(2)}%)`);
  if (rows.length < 100) console.log('  ⚠ 樣本不足（<100）');
}

function main() {
  const bench = loadBench();
  const stocks = loadStocks();
  const FROM = '2023-04-13';
  const trades: Trade[] = [];

  let done = 0;
  for (const s of stocks) {
    const cs = s.candles;
    for (let t = 60; t + 20 < cs.length; t++) {
      const c = cs[t];
      if (c.date < FROM) continue;
      if (!liquid(c)) continue;

      // 觸發：連漲 ≥3 天（收盤逐日走高）且 3 日累計漲幅 > 10%
      if (!(cs[t].close > cs[t - 1].close && cs[t - 1].close > cs[t - 2].close && cs[t - 2].close > cs[t - 3].close)) continue;
      const gain3 = cs[t - 3].close > 0 ? cs[t].close / cs[t - 3].close - 1 : 0;
      if (gain3 <= 0.10) continue;

      // 只取「連漲段剛滿足條件的第一天」，避免同一段連漲重複計數
      const prevRun = cs[t - 1].close > cs[t - 2].close && cs[t - 2].close > cs[t - 3].close && cs[t - 3].close > cs[t - 4]?.close;
      const prevGain = cs[t - 4]?.close > 0 ? cs[t - 1].close / cs[t - 4].close - 1 : 0;
      if (prevRun && prevGain > 0.10) continue;

      const refPrice = cs[t - 3].close; // 連漲起算前一根收盤
      const b = benchFwd(bench, c.date, 20);
      if (b == null) continue;

      const r: Trade['r'] = {};
      for (const p of POLICIES) r[p] = runPolicy(cs, t, refPrice, p);
      trades.push({ date: c.date, symbol: s.symbol, r, benchRet: b });
    }
    if (++done % 300 === 0) process.stdout.write('.');
  }
  console.log('');

  trades.sort((a, b) => (a.date < b.date ? -1 : 1));
  const mid = splitDate(trades);
  console.log(`\n===== 驗證 4：CH11-2 連漲3天+漲幅>10% 的出場政策比較 =====`);
  console.log(`觸發事件 ${trades.length} 筆，train/test 分界 ${mid}`);
  console.log(`報酬皆自「觸發日收盤」起算；refPrice=連漲前一根收盤（Policy B 的 20% 開關基準）`);
  console.log(`判定標準＝賠少：看平均虧損 / 最差 / P5 尾巴 / PF，不是看 alpha`);

  table('train（前半）', trades.filter(t => t.date < mid));
  table('test（後半）', trades.filter(t => t.date >= mid));
  table('全期', trades);

  console.log('\n判讀：課程政策要通過必須 train 與 test 兩段都同時做到');
  console.log('      (1) 平均虧損/P5 尾巴優於 B-current（賠少）且 (2) 平均報酬不明顯較差。');
}
main();
