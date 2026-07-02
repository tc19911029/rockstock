/**
 * C14 流動性硬篩回測對照組（研究專用，不動正式線）
 * 缺口 id：進場-3 / 進場-18
 *
 * 書本（朱家泓 5 步驟 CH5-2「特別報價選股法」）的「絕對流動性硬篩」：
 *   - 強弱榜：昨日成交量 < 500 張 → 剔除
 *   - 量放大榜：成交量 < 1000 張 → 剔除
 *   - 股價 < 5 元 → 剔除
 *
 * 現狀（production）：lib/scanner/TurnoverRank.ts 只用「20 日均成交額 top-N」+ 股價<5 地板，
 * 沒有「絕對張數地板」。本腳本把書本硬篩做成研究對照組，回答：
 *   在 top-500 成交額宇宙內，再加上「絕對張數地板」到底有沒有改善前瞻報酬 / 降低假突破率？
 *
 * 方法（對齊 factor-grid-search.ts）：
 *   - 全市場液態股、每週各取成交額 top-500 當基礎宇宙（= 現狀近似）
 *   - 隔日開盤進場、持有 20 日、超額對 ^TWII
 *   - train（前半）/ test（後半）一致才算數；raw 報酬不當 alpha
 *   - 假突破率：今日為 20 日新高收盤（突破）的樣本中，隔日收盤跌回突破日收盤以下的比率
 *
 * ⚠️ 純研究：不 import 也不改 production scanner / applyPanelFilter / StrategyConfig。
 *
 * 跑法：cd /Users/tc/Desktop/rockstock && npx tsx scripts/backtest-liquidity-floor.ts
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const FROM = '2024-07-20';
const FWD = 20;
const TOP_N = 500;

// 書本硬篩門檻（單位：張 / 元）
const FLOOR_STRONGWEAK_LOTS = 500;   // 強弱榜地板
const FLOOR_VOLEXPAND_LOTS = 1000;   // 量放大榜地板
const PRICE_FLOOR = 5;               // 股價地板（現狀已有，這裡同步驗）

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Row {
  code: string; date: string; iso: string; turnover: number; excess: number;
  vol: number;        // 今日成交量（張）
  prevVol: number;    // 昨日成交量（張）— 強弱榜地板用「昨量」
  close: number;
  isBreakout: boolean;     // 今日收盤 = 近20根新高（突破）
  nextCloseBelowBO: boolean; // 隔日收盤跌回今日收盤以下（突破後失敗 → 假突破）
}

async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }

function agg(rows: Row[]) {
  if (rows.length === 0) return { ex: 0, win: 0, n: 0 };
  const ex = rows.reduce((s, r) => s + r.excess, 0) / rows.length;
  const win = 100 * rows.filter(r => r.excess > 0).length / rows.length;
  return { ex, win, n: rows.length };
}
/** 假突破率：在「今日為突破」的樣本中，隔日收盤跌回突破日收盤以下的比率 */
function falseBreakoutRate(rows: Row[]) {
  const bo = rows.filter(r => r.isBreakout);
  if (bo.length === 0) return { rate: NaN, n: 0 };
  const fail = bo.filter(r => r.nextCloseBelowBO).length;
  return { rate: 100 * fail / bo.length, n: bo.length };
}

async function main() {
  const twiiFile = await readJ(path.join(C, '^TWII.json'));
  const twii: OHLC[] = twiiFile.candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };

  // 全市場 candle（含 .TW / .TWO），不靠 broker 檔（避免少掉沒籌碼檔的小型股 — 流動性研究要看全市場）
  const files = (await fs.readdir(C)).filter(f => /\.(TW|TWO)\.json$/.test(f));
  const all: Row[] = [];

  for (const f of files) {
    const code = f.replace(/\.json$/, '');
    const cdl = await readJ(path.join(C, f));
    if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0);
    if (cs.length < 60) continue;

    for (let t = 25; t + 1 + FWD < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      const ret = (cs[Math.min(t + 1 + FWD, cs.length - 1)].close / cs[t + 1].open - 1) * 100;
      if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[Math.min(t + 1 + FWD, cs.length - 1)].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;

      // 突破判定：今日收盤是近 20 根（含今日）最高收盤
      let hh = -Infinity;
      for (let k = t - 19; k <= t; k++) hh = Math.max(hh, cs[k].close);
      const isBreakout = cs[t].close >= hh - 1e-9;
      const nextCloseBelowBO = cs[t + 1].close < cs[t].close;

      all.push({
        code, date: cs[t].date, iso: isoWeek(cs[t].date),
        turnover: cs[t].close * (cs[t].volume || 0),
        excess: ret - mkt,
        vol: cs[t].volume || 0,
        prevVol: cs[t - 1].volume || 0,
        close: cs[t].close,
        isBreakout, nextCloseBelowBO,
      });
    }
  }

  // 每週各取成交額 top-N → 基礎宇宙（= 現狀 production 近似）
  const byW = new Map<string, Row[]>();
  for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: Row[] = [];
  for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, TOP_N)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  if (liq.length === 0) { console.log('無樣本'); return; }
  const mid = liq[Math.floor(liq.length / 2)].date;
  const splitTT = (rows: Row[]) => ({ train: rows.filter(r => r.date < mid), test: rows.filter(r => r.date >= mid) });

  console.log(`基礎宇宙（成交額 top-${TOP_N}）：${liq.length} 筆 | 期間 ${liq[0].date} ~ ${liq[liq.length - 1].date} | train/test 切點 ${mid}`);

  // ── 對照組定義 ──
  type Cohort = { name: string; pred: (r: Row) => boolean };
  const cohorts: Cohort[] = [
    { name: 'A 現狀（top-500，無絕對地板）', pred: () => true },
    { name: 'B +股價≥5元（現狀已有）', pred: r => r.close >= PRICE_FLOOR },
    { name: 'C +昨量≥500張（強弱榜地板）', pred: r => r.prevVol >= FLOOR_STRONGWEAK_LOTS },
    { name: 'D +今量≥1000張（量放大地板）', pred: r => r.vol >= FLOOR_VOLEXPAND_LOTS },
    { name: 'E 書本全硬篩（價≥5 ∧ 昨量≥500 ∧ 今量≥1000）', pred: r => r.close >= PRICE_FLOOR && r.prevVol >= FLOOR_STRONGWEAK_LOTS && r.vol >= FLOOR_VOLEXPAND_LOTS },
    // 被硬篩「剔除掉」的那群（書本說這些是要丟的爛股）— 看它們報酬是不是真的較差
    { name: 'X 被書本硬篩剔除的（價<5 ∨ 昨量<500 ∨ 今量<1000）', pred: r => !(r.close >= PRICE_FLOOR && r.prevVol >= FLOOR_STRONGWEAK_LOTS && r.vol >= FLOOR_VOLEXPAND_LOTS) },
  ];

  console.log('\n========== 前瞻報酬（隔日開盤進場、持有20日、超額對^TWII）==========');
  console.log('對照組                                              筆數  train超額/勝  →  test超額/勝   假突破率(train→test)');
  for (const c of cohorts) {
    const rows = liq.filter(c.pred);
    const { train, te } = (() => { const s = splitTT(rows); return { train: s.train, te: s.test }; })();
    const at = agg(train), ae = agg(te);
    const fbT = falseBreakoutRate(train), fbE = falseBreakoutRate(te);
    const n = rows.length;
    const trStr = `${(at.ex >= 0 ? '+' : '') + at.ex.toFixed(2)}%/${at.win.toFixed(0)}%`;
    const teStr = `${(ae.ex >= 0 ? '+' : '') + ae.ex.toFixed(2)}%/${ae.win.toFixed(0)}%`;
    const fbStr = `${isNaN(fbT.rate) ? 'NA' : fbT.rate.toFixed(0) + '%'}→${isNaN(fbE.rate) ? 'NA' : fbE.rate.toFixed(0) + '%'} (BO ${fbT.n}/${fbE.n})`;
    console.log(`  ${c.name.padEnd(46)} ${String(n).padStart(6)}  ${trStr.padEnd(12)} → ${teStr.padEnd(12)}  ${fbStr}`);
  }

  // ── 邊際效果：E vs A 的淨差（這才是「加硬篩到底改善多少」）──
  const A = liq.filter(cohorts[0].pred), E = liq.filter(cohorts[4].pred), X = liq.filter(cohorts[5].pred);
  const aA = agg(A), aE = agg(E), aX = agg(X);
  const dropped = A.length - E.length;
  console.log('\n========== 邊際效果（書本硬篩 vs 現狀）==========');
  console.log(`  現狀 top-500 樣本：${A.length} 筆，平均超額 ${(aA.ex >= 0 ? '+' : '') + aA.ex.toFixed(2)}%、勝率 ${aA.win.toFixed(1)}%`);
  console.log(`  加書本硬篩後保留：${E.length} 筆（剔除 ${dropped} 筆 = ${(100 * dropped / A.length).toFixed(1)}%），平均超額 ${(aE.ex >= 0 ? '+' : '') + aE.ex.toFixed(2)}%、勝率 ${aE.win.toFixed(1)}%`);
  console.log(`  被剔除那群：${X.length} 筆，平均超額 ${(aX.ex >= 0 ? '+' : '') + aX.ex.toFixed(2)}%、勝率 ${aX.win.toFixed(1)}%`);
  console.log(`  → 加硬篩對「保留股」平均超額的改善：${((aE.ex - aA.ex) >= 0 ? '+' : '') + (aE.ex - aA.ex).toFixed(3)} 個百分點`);
  console.log(`  → 被剔除股 vs 保留股 超額差：${((aX.ex - aE.ex) >= 0 ? '+' : '') + (aX.ex - aE.ex).toFixed(3)} 個百分點（負=書本對、剔除的較差）`);
  const fbA = falseBreakoutRate(A), fbE2 = falseBreakoutRate(E), fbX = falseBreakoutRate(X);
  console.log(`  → 假突破率：現狀 ${isNaN(fbA.rate) ? 'NA' : fbA.rate.toFixed(1) + '%'}（BO ${fbA.n}）/ 加硬篩 ${isNaN(fbE2.rate) ? 'NA' : fbE2.rate.toFixed(1) + '%'}（BO ${fbE2.n}）/ 被剔除 ${isNaN(fbX.rate) ? 'NA' : fbX.rate.toFixed(1) + '%'}（BO ${fbX.n}）`);

  console.log('\n判讀：');
  console.log('  - 若「加硬篩改善」≈0 且「剔除 %」很小 → 在 top-500 內絕對張數地板幾乎無作用（成交額排名已間接濾掉）。');
  console.log('  - 若被剔除股超額明顯較差且假突破率較高 → 書本硬篩有避雷意義，但要看是否落在 top-500 之外（那就不影響現狀）。');
  console.log('  - 真要進主視圖：E 須 train+test 都正且贏大盤，且優於 A。raw 報酬不算 alpha。');
}
main().catch(e => { console.error(e); process.exit(1); });
