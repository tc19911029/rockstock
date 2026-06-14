/**
 * 「大戶偷買」策略正規回測 — 真的模擬下單
 *   訊號(用上線同一個 lib/smartmoney/signal) → 隔天開盤買 → 停損紀律 → 算真實績效
 *   進場=隔日開盤(對齊實單，非掃描日收盤)；超額=同持有期 ^TWII
 *
 * 兩種出場政策：
 *   A 固定持有5日(收盤出，無停損) — 對照「下週漲跌」
 *   B 她的紀律：停損-8% / 停利+10% / 最多10日(收盤出)
 */
import { promises as fs } from 'fs';
import path from 'path';
import { evaluateAt, Candle } from '../lib/smartmoney/signal';
import { DEFAULT_PARAMS } from '../lib/smartmoney/types';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }

interface Trade { code: string; entryDate: string; exitDate: string; ret: number; excess: number; holdDays: number; stopped: boolean; tookProfit: boolean }

function summarize(label: string, trades: Trade[]) {
  if (!trades.length) { console.log(`${label}: 無交易`); return; }
  const n = trades.length;
  const rets = trades.map(t => t.ret).sort((a, b) => a - b);
  const avg = rets.reduce((s, r) => s + r, 0) / n;
  const med = rets[Math.floor(n / 2)];
  const win = 100 * trades.filter(t => t.ret > 0).length / n;
  const avgExcess = trades.reduce((s, t) => s + t.excess, 0) / n;
  const winExcess = 100 * trades.filter(t => t.excess > 0).length / n;
  const gains = trades.filter(t => t.ret > 0).reduce((s, t) => s + t.ret, 0);
  const losses = trades.filter(t => t.ret < 0).reduce((s, t) => s + Math.abs(t.ret), 0);
  const pf = losses > 0 ? gains / losses : Infinity;
  const stopped = 100 * trades.filter(t => t.stopped).length / n;
  // top 10% 大贏家貢獻多少總報酬
  const sortedDesc = [...trades].sort((a, b) => b.ret - a.ret);
  const topK = Math.max(1, Math.round(n * 0.1));
  const topSum = sortedDesc.slice(0, topK).reduce((s, t) => s + t.ret, 0);
  const totalSum = rets.reduce((s, r) => s + r, 0);
  const topShare = totalSum !== 0 ? 100 * topSum / totalSum : 0;
  const avgHold = trades.reduce((s, t) => s + t.holdDays, 0) / n;

  console.log(`\n【${label}】 ${n} 筆交易`);
  console.log(`  平均報酬 ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%   中位數 ${med >= 0 ? '+' : ''}${med.toFixed(2)}%   勝率 ${win.toFixed(0)}%`);
  console.log(`  超額(vs大盤) ${avgExcess >= 0 ? '+' : ''}${avgExcess.toFixed(2)}%   贏大盤比例 ${winExcess.toFixed(0)}%`);
  console.log(`  獲利因子 ${pf === Infinity ? '∞' : pf.toFixed(2)}   停損出場 ${stopped.toFixed(0)}%   平均持有 ${avgHold.toFixed(1)} 天`);
  console.log(`  最賺10%交易貢獻了 ${topShare.toFixed(0)}% 的總報酬  (越高=越靠少數大贏家)`);
}

async function main() {
  const files = (await fs.readdir(INST_DIR)).filter(f => f.endsWith('.json'));

  // ^TWII 大盤：date -> close
  const twii: OHLC[] = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, '^TWII.json'), 'utf8')).candles;
  const twiiClose = new Map<string, number>();
  for (const c of twii) twiiClose.set(c.date, c.close);
  const twiiDates = twii.map(c => c.date);
  const twiiCloseAtOrBefore = (d: string): number | null => {
    let lo = 0, hi = twiiDates.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (twiiDates[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? null : twii[ans].close;
  };

  const tradesA: Trade[] = []; // 固定5日
  const tradesB: Trade[] = []; // 停損紀律
  let minD = '9999', maxD = '0';

  for (const f of files) {
    const code = f.replace('.json', '');
    if (!/^\d{4}$/.test(code)) continue;
    let inst: any, cdl: any;
    try {
      inst = JSON.parse(await fs.readFile(path.join(INST_DIR, f), 'utf8'));
      cdl = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, `${code}.TW.json`), 'utf8'));
    } catch { continue; }
    const idays: any[] = inst.data || [];
    const candles: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0);
    if (idays.length < 20 || candles.length < 30) continue;
    const instByDate = new Map<string, number>();
    for (const d of idays) instByDate.set(d.date, d.total ?? 0);

    let lockUntilA = -1, lockUntilB = -1; // 避免同檔重疊持倉

    for (let t = DEFAULT_PARAMS.lookback; t + 1 < candles.length; t++) {
      const ev = evaluateAt(candles as Candle[], instByDate, t, DEFAULT_PARAMS);
      if (!ev || !ev.isHit) continue;

      const entryIdx = t + 1;
      const entry = candles[entryIdx].open;
      if (!(entry > 0)) continue;
      const entryDate = candles[entryIdx].date;
      const twiiEntry = twiiCloseAtOrBefore(entryDate);
      if (entryDate < minD) minD = entryDate;
      if (entryDate > maxD) maxD = entryDate;

      // ── 政策 A：固定持有 5 日，收盤出 ──
      if (entryIdx > lockUntilA) {
        const exitIdx = Math.min(entryIdx + 5, candles.length - 1);
        const exit = candles[exitIdx].close;
        const ret = (exit / entry - 1) * 100;
        const twiiExit = twiiCloseAtOrBefore(candles[exitIdx].date);
        const mkt = twiiEntry && twiiExit ? (twiiExit / twiiEntry - 1) * 100 : 0;
        if (Math.abs(ret) <= 60) {
          tradesA.push({ code, entryDate, exitDate: candles[exitIdx].date, ret, excess: ret - mkt, holdDays: exitIdx - entryIdx, stopped: false, tookProfit: false });
          lockUntilA = exitIdx;
        }
      }

      // ── 政策 B：停損 -8% / 停利 +10% / 最多 10 日 ──
      if (entryIdx > lockUntilB) {
        const stop = entry * 0.92, target = entry * 1.10;
        let exitIdx = Math.min(entryIdx + 10, candles.length - 1);
        let exitPx = candles[exitIdx].close;
        let stopped = false, took = false;
        for (let k = entryIdx + 1; k <= Math.min(entryIdx + 10, candles.length - 1); k++) {
          const bar = candles[k];
          if (bar.low <= stop) { exitIdx = k; exitPx = stop; stopped = true; break; }   // 停損優先(保守)
          if (bar.high >= target) { exitIdx = k; exitPx = target; took = true; break; }
        }
        const ret = (exitPx / entry - 1) * 100;
        const twiiExit = twiiCloseAtOrBefore(candles[exitIdx].date);
        const mkt = twiiEntry && twiiExit ? (twiiExit / twiiEntry - 1) * 100 : 0;
        if (Math.abs(ret) <= 60) {
          tradesB.push({ code, entryDate, exitDate: candles[exitIdx].date, ret, excess: ret - mkt, holdDays: exitIdx - entryIdx, stopped, tookProfit: took });
          lockUntilB = exitIdx;
        }
      }
    }
  }

  console.log('================================================');
  console.log('「大戶偷買」策略回測（真實下單模擬）');
  console.log('================================================');
  console.log(`條件: 近${DEFAULT_PARAMS.lookback}日跌>${-DEFAULT_PARAMS.dropMax}% + 法人集中度>${DEFAULT_PARAMS.concMin}%`);
  console.log(`進場: 隔日開盤   期間: ${minD} ~ ${maxD}`);
  summarize('政策A 固定持有5日(無停損)', tradesA);
  summarize('政策B 她的紀律(停損-8%/停利+10%/最多10日)', tradesB);

  console.log('\n判讀：超額>0 且勝率明顯>50% 才算真有用；獲利因子>1.3 較穩；');
  console.log('「最賺10%貢獻」太高(>70%)= 靠少數翻倍股、實務上抓不到就會虧。');
}

main().catch(e => { console.error(e); process.exit(1); });
