/**
 * 測驗：朱家泓「六條件選股」改用 30 分K + 賺 3~5% 就跑（停利+停損）。
 *
 * ⚠️ 兩個誠實前提（結果只能看形狀/密度，不能當淨 alpha 證據）：
 *   1. 分鐘K無封存 → 只能即時抓；台股 Fugle 回看 ~3 個月、陸股騰訊 800 根 ~半年。樣本很短。
 *   2. 六條件「原封不動照搬」日K參數（MA5/10/20/60、量比1.3、乖離15%、MACD 10-20-10、KD 5-3-3）
 *      算在 30 分K 上：程式照跑，但「季線=60根」在30分K只有~7天、乖離15%幾乎不觸發，尺度會偏。
 *
 * 選股 = evaluateSixConditions 的 coreScore===5（前5必要條件全過），不疊戒律/淘汰法
 *        （那些靠日頻法人籌碼+季線語意，30分K 無對應）。
 * 進場 = 訊號次一根 30分K 開盤。出場 = 固定停利/停損，同根都碰保守算停損先，超過最大持有收盤平倉。
 * 純離線讀取+印表，不動生產程式、不落地存檔。
 *
 * 跑法： npx tsx scripts/backtest-six-conditions-30m.ts
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
if (existsSync('.env.local')) config({ path: '.env.local' });

import { getFugleHistoricalMinuteCandles } from '../lib/datasource/FugleProvider';
import { computeIndicators } from '../lib/indicators';
import { evaluateSixConditions } from '../lib/analysis/trendAnalysis';
import type { Candle } from '../types/index';

const TOP_N = 100;
const WARMUP = 120;                       // 前120根當暖機（MA60/KD/MACD 遞迴 EMA 要夠長）
const COST = { TW: 0.006, CN: 0.0013 };   // 單邊來回成本估計
const BARS_PER_DAY = { TW: 9, CN: 8 };    // 30分K每日根數（TW 09:00-13:30、CN 4+4）
const TP_LIST = [0.03, 0.04, 0.05];       // 停利：+3% / +4% / +5%
const SL_LIST = [0.05, 0.07];             // 停損：-5% / -7%
const HOLD_DAYS = [2, 5];                 // 最大持有天數

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Trade { retNet: number; bars: number; exit: 'tp' | 'sl' | 'time' }

async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }

// 騰訊代碼：滬(.SS)=shXXX、深(.SZ)=szXXX
function tencentCode(sym: string): string {
  const code = sym.replace(/\.(SS|SZ)$/i, '');
  return (/\.SS$/i.test(sym) ? 'sh' : 'sz') + code;
}
// 抓騰訊 30分K（curl --noproxy 直連 — 陸股域名不可走代理否則國外節點 502）
function fetchCN30m(sym: string): OHLC[] {
  const tc = tencentCode(sym);
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${tc},m30,,800`;
  try {
    const out = execFileSync('curl', ['--noproxy', '*', '-s', '--max-time', '25', url], { maxBuffer: 64 * 1024 * 1024 }).toString();
    const arr: string[][] = JSON.parse(out)?.data?.[tc]?.m30 ?? [];
    return arr.map(k => ({ date: `${k[0].slice(0, 4)}-${k[0].slice(4, 6)}-${k[0].slice(6, 8)} ${k[0].slice(8, 10)}:${k[0].slice(10, 12)}`, open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +k[5] }));
  } catch { return []; }
}

// 一檔股票逐根跑六條件，回傳 coreScore===5 的 bar index 陣列
function findSignals(bars: OHLC[]): number[] {
  if (bars.length < WARMUP + 5) return [];
  const ind = computeIndicators(bars as Candle[]);
  const sig: number[] = [];
  for (let i = WARMUP; i < bars.length - 1; i++) {   // -1：進場要有次一根
    try {
      if (evaluateSixConditions(ind, i).coreScore === 5) sig.push(i);
    } catch { /* 個別根算不出指標就跳過 */ }
  }
  return sig;
}

// 給定訊號清單 + tp/sl/最大持有根數，模擬進出場（一次一單，在倉不重複進場）
function simulate(bars: OHLC[], signals: number[], tp: number, sl: number, holdBars: number, cost: number): Trade[] {
  const trades: Trade[] = [];
  let nextFree = 0;
  for (const s of signals) {
    if (s < nextFree) continue;               // 還在倉，跳過
    const entryIdx = s + 1;                    // 次一根開盤進場
    if (entryIdx >= bars.length) break;
    const entry = bars[entryIdx].open;
    if (!(entry > 0)) continue;
    const tpPrice = entry * (1 + tp), slPrice = entry * (1 - sl);
    const lastK = Math.min(entryIdx + holdBars - 1, bars.length - 1);
    let done = false;
    for (let k = entryIdx; k <= lastK; k++) {
      const c = bars[k];
      // 同根兩者都碰 → 保守假設先觸發停損
      if (c.low <= slPrice) { trades.push({ retNet: -sl * 100 - cost * 100, bars: k - entryIdx + 1, exit: 'sl' }); nextFree = k + 1; done = true; break; }
      if (c.high >= tpPrice) { trades.push({ retNet: tp * 100 - cost * 100, bars: k - entryIdx + 1, exit: 'tp' }); nextFree = k + 1; done = true; break; }
    }
    if (!done) {                               // 抱到最大持有，收盤平倉
      const c = bars[lastK];
      trades.push({ retNet: (c.close / entry - 1) * 100 - cost * 100, bars: lastK - entryIdx + 1, exit: 'time' });
      nextFree = lastK + 1;
    }
  }
  return trades;
}

function report(label: string, ts: Trade[], barsPerDay: number) {
  if (!ts.length) { console.log(`  ${label}: 無交易`); return; }
  const n = ts.length;
  const wins = ts.filter(t => t.retNet > 0), losses = ts.filter(t => t.retNet <= 0);
  const tpHit = ts.filter(t => t.exit === 'tp').length;
  const slHit = ts.filter(t => t.exit === 'sl').length;
  const avg = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const ev = avg(ts.map(t => t.retNet));
  console.log(`  ${label}: ${n} 筆  停利命中 ${(tpHit / n * 100).toFixed(0)}%  停損 ${(slHit / n * 100).toFixed(0)}%  賺機率 ${(wins.length / n * 100).toFixed(0)}%`);
  console.log(`      平均賺 +${avg(wins.map(t => t.retNet)).toFixed(2)}%  平均賠 ${avg(losses.map(t => t.retNet)).toFixed(2)}%  每筆期望(淨,含beta) ${ev >= 0 ? '+' : ''}${ev.toFixed(2)}%  平均抱 ${(avg(ts.map(t => t.bars)) / barsPerDay).toFixed(1)}天`);
}

async function runMarket(mkt: 'TW' | 'CN') {
  const dir = path.join(process.cwd(), `data/candles/${mkt}`);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json') && !f.startsWith('^'));
  // 依近60日成交額中位數挑前 TOP_N
  const ranked: { sym: string; med: number }[] = [];
  for (const f of files) {
    const sym = f.replace('.json', '');
    if (mkt === 'CN' && (/^000\d{3}\.SS$/.test(sym) || /^399\d{3}\.SZ$/.test(sym))) continue; // 剔除陸股指數
    const j = await readJ(path.join(dir, f)); const cs: OHLC[] = j?.candles ?? j;
    if (!Array.isArray(cs) || cs.length < 60) continue;
    const t = cs.slice(-60).map(c => c.close * (c.volume || 0)).filter(x => x > 0).sort((a, b) => a - b);
    if (!t.length) continue;
    ranked.push({ sym, med: t[Math.floor(t.length / 2)] });
  }
  ranked.sort((a, b) => b.med - a.med);
  const picks = ranked.slice(0, TOP_N);

  console.log(`\n==================== ${mkt} ====================`);
  console.log(`挑近60日成交額前 ${picks.length} 大，逐檔抓 30分K…`);

  // 逐檔抓K + 找訊號（六條件只算一次）
  const stocks: { sym: string; bars: OHLC[]; signals: number[] }[] = [];
  let ok = 0, empty = 0, sigTotal = 0;
  for (const p of picks) {
    let bars: OHLC[];
    if (mkt === 'TW') {
      const cs = await getFugleHistoricalMinuteCandles(p.sym.replace(/\.TW$/i, ''), '30m', '3mo'); // Fugle 要裸碼

      bars = [...(cs as OHLC[])].sort((a, b) => a.date.localeCompare(b.date)); // Fugle 降序→升序
    } else {
      bars = fetchCN30m(p.sym); // 騰訊本來就升序
    }
    if (!bars.length) { empty++; continue; }
    ok++;
    const signals = findSignals(bars);
    sigTotal += signals.length;
    if (signals.length) stocks.push({ sym: p.sym, bars, signals });
  }
  console.log(`抓到 ${ok} 檔 / 空 ${empty} 檔；共 ${sigTotal} 個六條件(5/5)訊號\n`);

  const bpd = BARS_PER_DAY[mkt], cost = COST[mkt];
  for (const holdDays of HOLD_DAYS) {
    const holdBars = holdDays * bpd;
    console.log(`── 最大持有 ${holdDays} 天（${holdBars} 根30分K）──`);
    for (const tp of TP_LIST) {
      for (const sl of SL_LIST) {
        const all: Trade[] = [];
        for (const st of stocks) all.push(...simulate(st.bars, st.signals, tp, sl, holdBars, cost));
        report(`停利+${(tp * 100).toFixed(0)}% / 停損-${(sl * 100).toFixed(0)}%`, all, bpd);
      }
    }
    console.log('');
  }
}

async function main() {
  console.log('六條件選股改用 30分K 測驗（停利+停損）');
  console.log('⚠️ 樣本短（台股~3月/陸股~半年、無封存），期望值含大盤beta，只能看形狀不能當 alpha 證據。');
  console.log('⚠️ 六條件用日K參數原封不動照搬到30分K，季線/乖離/量比尺度會偏；未疊戒律/淘汰法。');
  for (const mkt of ['TW', 'CN'] as const) {
    try { await runMarket(mkt); } catch (e) { console.log(`\n${mkt} 失敗：`, (e as Error).message); }
  }
}
main();
