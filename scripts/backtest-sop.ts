// ============================================================
// daily-pick SOP 端到端回測 —— 「照這套 SOP 真的去交易，會不會賺」
//
// 前面 rank-edge 只量「前瞻平均收盤報酬」，沒模擬出場 → 不是真實交易。
// 本腳本模擬完整 SOP（含停損+持有規則，這才是勝率4成能不能賺錢的關鍵）：
//   每個交易日 T：三色紅+觸發候選 → 依當日漲幅取 top3 → 隔日(T+1)開盤買入 →
//   出場規則：跌破停損收盤就砍（停損=computeStop 守訊號紅K低，夾3-7%）/
//             最多持有 20 交易日，先到者出 → 算每筆「真實已實現損益」。
//
// 無未來偏誤：選股/排序/停損價全用 T 與之前資料；T+1 開盤進場；漲停買不到剔除；
//   出場每天只比「當日收盤 vs 事先定好的停損」，不偷看之後的棒。
//
// 對照組：
//   - SOP_TOP3  = 每日漲幅 top3（本 SOP）
//   - ALL_SIGNAL= 三色訊號全買（不排序，同出場規則）→ 看「排序+取前3」有沒有加分
//   - 大盤超額  = 每筆扣掉同持有期 ^TWII 報酬
//
// 關鍵指標：勝率、平均賺/賠、賺賠比(R)、獲利因子(PF=總賺/總賠)、每筆平均報酬、
//   扣成本後淨值、停損出場占比。PF>1 才賺；>1.3 才算穩。
//
// ⚠️ 三色自創因子，研究用不改 production（鐵則#5）。本地K存活偏差→絕對值偏樂觀，
//    停損用收盤價（SOP「跌破停損收盤砍」），實單盤中觸停會更差一點。
//
// 用法：npx tsx scripts/backtest-sop.ts [days=480] [topN=3] [hold=20] [limit=0]
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { computeDualB, computeXys } from '@/lib/cn-sanse/dualB';
import { isNum } from '@/lib/cn-sanse/tdx';
import type { Candle } from '@/types';

// 停損守訊號日紅K低，夾在現價 -3% ~ -7% 之間（原 lib/dailyPick/buildDailyPick，已隨每日選股功能移除 → 內聯）
function computeStop(price: number, signalLow: number | null): { stop: number; stopPct: number } {
  const floor7 = price * 0.93;
  const ceil3 = price * 0.97;
  const raw = signalLow ?? floor7;
  const stop = Math.max(floor7, Math.min(raw, ceil3));
  return { stop: +stop.toFixed(2), stopPct: +(((stop - price) / price) * 100).toFixed(1) };
}

const ENTRY_MIN_IDX = 480;
const LIMIT_GAP = 0.095;
const COST_ROUNDTRIP = 0.5; // 來回手續費+稅粗估 %（買0.1425%×折+賣0.1425%×折+證交稅0.3%≈0.5%）
const TW_INDEX = '^TWII';

interface Trade {
  symbol: string; date: string; changePct: number;
  ret: number;            // 已實現報酬 %（扣費前）
  holdDays: number;
  exitReason: 'stop' | 'time';
  idxRet: number;         // 同持有期大盤報酬 %
}

async function readRaw(dir: string, symbol: string): Promise<Candle[] | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${symbol}.json`), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.candles)) return null;
    const cs = data.candles as Candle[];
    for (const c of cs) if (typeof c.date === 'string' && c.date.endsWith('*')) c.date = c.date.slice(0, -1);
    return cs;
  } catch { return null; }
}
function isCommonTw(file: string): boolean {
  const m = file.match(/^(\d{4})\.(TW|TWO)\.json$/);
  return !!m && !m[1].startsWith('00');
}
function dateToCloseMap(cs: Candle[] | null): Map<string, number> {
  const m = new Map<string, number>();
  if (cs) for (const c of cs) m.set(c.date, c.close);
  return m;
}

interface Cand {
  symbol: string; date: string; changePct: number;
  entryOpen: number; stop: number;
  fwdClose: number[]; // 進場日起 hold 根收盤
  exitDates: string[];
}

async function main() {
  const days = parseInt(process.argv[2] ?? '480', 10) || 480;
  const topN = parseInt(process.argv[3] ?? '3', 10) || 3;
  const hold = parseInt(process.argv[4] ?? '20', 10) || 20;
  const limit = parseInt(process.argv[5] ?? '0', 10) || 0;
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = getLocalCandleDir('TW');
  const outDir = path.join(process.cwd(), 'data', 'backtest-output');
  await fs.mkdir(outDir, { recursive: true });

  const idxCandles = await readRaw(dir, TW_INDEX);
  const idxMap = dateToCloseMap(idxCandles);
  const idxByDate = new Map<string, number>();
  if (idxCandles) idxCandles.forEach((c, i) => idxByDate.set(c.date, i));
  const idxCloseArr = idxCandles?.map(c => c.close) ?? [];
  if (idxMap.size === 0) throw new Error(`找不到指數本地K線（${TW_INDEX}）`);

  let universe = (await fs.readdir(dir)).filter(isCommonTw).map((f) => f.replace(/\.json$/, ''));
  if (limit > 0) universe = universe.slice(0, limit);
  console.log(`[sop] TW universe ${universe.length} 檔｜top${topN}｜持有${hold}日｜停損守訊號紅K低(3-7%)｜進場隔日開盤`);

  // date → 當日三色訊號候選（帶進場價/停損/未來收盤序列，供之後排序+模擬出場）
  const byDate = new Map<string, Cand[]>();
  let stocksUsed = 0, totalSignals = 0;
  const t0 = Date.now();
  const BATCH = 40;
  for (let b = 0; b < universe.length; b += BATCH) {
    const batch = universe.slice(b, b + BATCH);
    const loaded = await Promise.all(batch.map((sym) => readRaw(dir, sym)));
    for (let k = 0; k < batch.length; k++) {
      const symbol = batch[k];
      const candles = loaded[k];
      if (!candles || candles.length < ENTRY_MIN_IDX + hold + 8) continue;
      try {
        let last = NaN;
        const indexClose = candles.map((c) => { const v = idxMap.get(c.date); if (v != null) last = v; return last; });
        const s = computeSanSe(candles, indexClose);
        const red = s.midStrength.map((x) => isNum(x) && x > 0);
        const db = computeDualB(candles);
        const xys = computeXys(candles);
        const O = candles.map(c => c.open), H = candles.map(c => c.high), L = candles.map(c => c.low), C = candles.map(c => c.close);
        const n = candles.length;
        const hiIdx = n - 1 - (hold + 1);
        let used = false;
        for (let i = ENTRY_MIN_IDX; i <= hiIdx; i++) {
          const sanseBuy = red[i] && (db.goldCross[i] || db.breakUp[i] || xys.goldCross[i]);
          if (!sanseBuy) continue;
          const e = i + 1; // 進場日
          const base = O[e];
          if (!(base > 0)) continue;
          // 漲停買不到剔除
          const locked = L[e] > 0 && O[e] === H[e] && (H[e] - L[e]) / L[e] < 0.005;
          const gapUp = (O[e] - C[i]) / C[i];
          if (locked || gapUp >= LIMIT_GAP) continue;
          const { stop } = computeStop(C[i], L[i]); // 停損守訊號日(T)紅K低，夾3-7%
          const changePct = i > 0 && C[i - 1] > 0 ? ((C[i] - C[i - 1]) / C[i - 1]) * 100 : 0;
          const fwdClose: number[] = [];
          const exitDates: string[] = [];
          for (let d = 0; d < hold && e + d < n; d++) { fwdClose.push(C[e + d]); exitDates.push(candles[e + d].date); }
          if (fwdClose.length < hold) continue; // 未來棒不足 → 跳（避免截斷偏差）
          used = true; totalSignals++;
          const cand: Cand = { symbol, date: candles[i].date, changePct, entryOpen: base, stop, fwdClose, exitDates };
          const arr = byDate.get(cand.date);
          if (arr) arr.push(cand); else byDate.set(cand.date, [cand]);
        }
        if (used) stocksUsed++;
      } catch { /* skip */ }
    }
    if ((b / BATCH) % 5 === 0) console.log(`[sop] 進度 ${Math.min(b + BATCH, universe.length)}/${universe.length}｜訊號 ${totalSignals}｜${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  const dates = [...byDate.keys()].sort();
  console.log(`[sop] 完成：用 ${stocksUsed} 檔｜訊號 ${totalSignals}｜交易日 ${dates.length}（${dates[0]} ~ ${dates[dates.length - 1]}）`);

  // 模擬一筆：進場 entryOpen，每日收盤比停損，跌破當日收盤出；否則持有到 hold 末日收盤
  function simulate(c: Cand): Trade {
    let exitIdx = c.fwdClose.length - 1;
    let exitReason: 'stop' | 'time' = 'time';
    for (let d = 0; d < c.fwdClose.length; d++) {
      if (c.fwdClose[d] < c.stop) { exitIdx = d; exitReason = 'stop'; break; }
    }
    const exitClose = c.fwdClose[exitIdx];
    const ret = ((exitClose - c.entryOpen) / c.entryOpen) * 100;
    // 大盤同持有期報酬：進場日 ~ 出場日
    let idxRet = 0;
    const eiStart = idxByDate.get(c.exitDates[0]);
    const eiEnd = idxByDate.get(c.exitDates[exitIdx]);
    if (eiStart != null && eiEnd != null && idxCloseArr[eiStart] > 0) {
      idxRet = ((idxCloseArr[eiEnd] - idxCloseArr[eiStart]) / idxCloseArr[eiStart]) * 100;
    }
    return { symbol: c.symbol, date: c.date, changePct: c.changePct, ret, holdDays: exitIdx + 1, exitReason, idxRet };
  }

  function collect(picker: (cands: Cand[]) => Cand[]): Trade[] {
    const out: Trade[] = [];
    for (const d of dates) out.push(...picker([...byDate.get(d)!]).map(simulate));
    return out;
  }

  const sopTrades = collect((cs) => cs.sort((a, b) => b.changePct - a.changePct).slice(0, topN));
  const allTrades = collect((cs) => cs);

  function report(name: string, trades: Trade[]): string[] {
    const n = trades.length;
    if (!n) return [`### ${name}：無交易`];
    const rets = trades.map(t => t.ret);
    const net = rets.map(r => r - COST_ROUNDTRIP);
    const wins = net.filter(r => r > 0), losses = net.filter(r => r <= 0);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    const avg = (a: number[]) => a.length ? sum(a) / a.length : 0;
    const winRate = (wins.length / n) * 100;
    const avgWin = avg(wins), avgLoss = avg(losses);
    const pf = losses.length ? sum(wins) / Math.abs(sum(losses)) : Infinity;
    const avgNet = avg(net);
    const avgGross = avg(rets);
    const med = [...net].sort((a, b) => a - b)[Math.floor(n / 2)];
    const excess = avg(trades.map(t => t.ret - t.idxRet));
    const stopPct = (trades.filter(t => t.exitReason === 'stop').length / n) * 100;
    const avgHold = avg(trades.map(t => t.holdDays));
    const totalNet = sum(net);
    return [
      `### ${name}`,
      '',
      `- 交易筆數 ${n}｜平均持有 ${avgHold.toFixed(1)} 日｜停損出場占 ${stopPct.toFixed(0)}%`,
      `- 勝率 ${winRate.toFixed(1)}%｜平均賺 ${avgWin >= 0 ? '+' : ''}${avgWin.toFixed(2)}%｜平均賠 ${avgLoss.toFixed(2)}%｜賺賠比 ${avgLoss !== 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : '—'}`,
      `- **獲利因子 PF ${pf === Infinity ? '∞' : pf.toFixed(2)}**（>1 賺、>1.3 穩）｜每筆平均(扣費) **${avgNet >= 0 ? '+' : ''}${avgNet.toFixed(2)}%**（扣費前 ${avgGross >= 0 ? '+' : ''}${avgGross.toFixed(2)}%）`,
      `- 中位數(扣費) ${med >= 0 ? '+' : ''}${med.toFixed(2)}%｜vs 大盤同期超額(扣費前) ${excess >= 0 ? '+' : ''}${excess.toFixed(2)}%｜累計(扣費,單利) ${totalNet >= 0 ? '+' : ''}${totalNet.toFixed(0)}%`,
      '',
    ];
  }

  const lines: string[] = [];
  lines.push(`# daily-pick SOP 端到端回測（TW，${stamp}）`);
  lines.push('');
  lines.push(`SOP：三色紅+觸發 → 依當日漲幅取 top${topN} → 隔日開盤買 → 跌破停損(守訊號紅K低,夾3-7%)收盤砍 / 最多持有 ${hold} 日`);
  lines.push(`用 ${stocksUsed} 檔｜訊號 ${totalSignals}｜交易日 ${dates.length}（${dates[0]} ~ ${dates[dates.length - 1]}）｜來回成本估 ${COST_ROUNDTRIP}%`);
  lines.push('');
  lines.push('> ⚠️ 本地K存活偏差→偏樂觀；停損用收盤(實單盤中觸停更差)；單利累計非複利。三色自創因子不改 production。');
  lines.push('');
  lines.push(...report(`SOP：每日漲幅 top${topN}（本策略）`, sopTrades));
  lines.push(...report('對照：三色訊號全買（不排序，同出場）', allTrades));

  // 自動結論
  const sopNet = sopTrades.map(t => t.ret - COST_ROUNDTRIP);
  const sumW = sopNet.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const sumL = Math.abs(sopNet.filter(r => r <= 0).reduce((a, b) => a + b, 0));
  const pf = sumL ? sumW / sumL : Infinity;
  const avgNet = sopNet.reduce((a, b) => a + b, 0) / (sopNet.length || 1);
  lines.push('## 自動結論（這套 SOP 到底有沒有用）');
  lines.push('');
  const verdict = pf >= 1.3
    ? `✅ SOP 有用：扣費後 PF ${pf.toFixed(2)}、每筆平均 +${avgNet.toFixed(2)}% — 停損把輸家砍小、靠贏家把整體拉正，名副其實「砍輸家抱贏家」。`
    : pf > 1.0
      ? `➖ SOP 勉強正期望：扣費後 PF ${pf.toFixed(2)}、每筆 ${avgNet >= 0 ? '+' : ''}${avgNet.toFixed(2)}% — 有微弱 edge 但很薄，執行紀律與成本控制決定生死。`
      : `❌ SOP 扣費後不賺：PF ${pf.toFixed(2)}、每筆 ${avgNet.toFixed(2)}% — 訊號的薄 edge 被交易成本吃光，需放大持有/減少進出或換更強訊號。`;
  lines.push(`> ${verdict}`);
  lines.push('');

  const md = lines.join('\n');
  await fs.writeFile(path.join(outDir, `sop-backtest-${stamp}.md`), md + '\n');
  console.log('\n' + md);
  console.log(`\n📄 已寫入 ${path.join(outDir, `sop-backtest-${stamp}.md`)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
