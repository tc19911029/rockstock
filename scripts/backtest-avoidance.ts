// ============================================================
// 避雷層回測 —— 「不能買的強股」假設驗證
//
// 規格書核心主張：很多強股是陷阱(高檔長上影/爆量長黑/爆量收弱)，避開它們能改善績效。
// 測法：三色紅+觸發訊號 → 在進場決策日(T)算「價量避雷旗標」(只用T與之前資料) →
//   把訊號拆 CLEAN(無旗標) vs FLAGGED(中旗標) → 同 SOP 出場(隔日開盤進、跌破停損收盤砍、
//   最多20日) → 比較兩桶賺賠比/獲利因子。FLAGGED 明顯較差 = 避雷有用、你的直覺對。
//
// 為何只測價量型避雷：融資/估值/大戶/節目缺2年歷史(融資06-11才存、估值6檔、TDCC已證無alpha)，
//   無法無偏誤回測；價量型(高檔長上影/爆量長黑/爆量收弱)從L1算得出、有完整歷史，
//   且正是規格書 Step14 列在最前面的避雷項。
//
// 旗標定義(進場決策日 i，全用 candles[0..i])：
//   longUpperShadow  上影>1.5×實體 且 上影/收>3%  → 沖高回落
//   volSpikeWeakClose 量>2×20日均量 且 收在當日區間下40%  → 爆量收弱
//   recentHighVolBlack 近3日內有「量>2.5×均量 且 黑K 且 實體>3%」  → 高檔爆量長黑
//
// 無未來偏誤：旗標/排序/停損用T及之前；隔日開盤進場；漲停買不到剔除；未來棒只算出場。
// ⚠️ 三色自創因子、研究用不改 production；本地K存活偏差→看「CLEAN vs FLAGGED 相對差」。
//
// 用法：npx tsx scripts/backtest-avoidance.ts [days=480] [hold=20] [limit=0]
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { computeDualB, computeXys } from '@/lib/cn-sanse/dualB';
import { isNum } from '@/lib/cn-sanse/tdx';
import { computeStop } from '@/lib/dailyPick/buildDailyPick';
import type { Candle } from '@/types';

const ENTRY_MIN_IDX = 480;
const LIMIT_GAP = 0.095;
const COST_ROUNDTRIP = 0.5;

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
function smaVol(vol: number[]): number[] {
  const out = new Array(vol.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < vol.length; i++) {
    sum += vol[i];
    if (i >= 20) sum -= vol[i - 20];
    if (i >= 19) out[i] = sum / 20;
  }
  return out;
}

interface Trade { ret: number; flagged: boolean; flags: string[]; changePct: number; date: string; symbol: string; }

async function main() {
  const days = parseInt(process.argv[2] ?? '480', 10) || 480;
  const hold = parseInt(process.argv[3] ?? '20', 10) || 20;
  const limit = parseInt(process.argv[4] ?? '0', 10) || 0;
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = getLocalCandleDir('TW');
  const outDir = path.join(process.cwd(), 'data', 'backtest-output');
  await fs.mkdir(outDir, { recursive: true });

  const idxCandles = await readRaw(dir, '^TWII');
  const idxMap = new Map<string, number>();
  if (idxCandles) for (const c of idxCandles) idxMap.set(c.date, c.close);

  let universe = (await fs.readdir(dir)).filter(isCommonTw).map((f) => f.replace(/\.json$/, ''));
  if (limit > 0) universe = universe.slice(0, limit);
  console.log(`[avoid] TW universe ${universe.length} 檔｜三色訊號拆 CLEAN vs FLAGGED｜持有${hold}日`);

  // 收集所有訊號 trade（含 SOP 出場已實現報酬 + 避雷旗標）
  const allTrades: Trade[] = [];
  const byDate = new Map<string, Trade[]>(); // 給 top3 子集用
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
        const O = candles.map(c => c.open), H = candles.map(c => c.high), L = candles.map(c => c.low), C = candles.map(c => c.close), V = candles.map(c => c.volume);
        const va = smaVol(V);
        const n = candles.length;
        const hiIdx = n - 1 - (hold + 1);
        let used = false;
        for (let i = ENTRY_MIN_IDX; i <= hiIdx; i++) {
          const sanseBuy = red[i] && (db.goldCross[i] || db.breakUp[i] || xys.goldCross[i]);
          if (!sanseBuy) continue;
          const e = i + 1;
          const base = O[e];
          if (!(base > 0)) continue;
          const locked = L[e] > 0 && O[e] === H[e] && (H[e] - L[e]) / L[e] < 0.005;
          if (locked || (O[e] - C[i]) / C[i] >= LIMIT_GAP) continue;

          // ── 避雷旗標（全用 [0..i]）──
          const flags: string[] = [];
          const body = Math.abs(C[i] - O[i]);
          const upperShadow = H[i] - Math.max(O[i], C[i]);
          const range = H[i] - L[i];
          const closePos = range > 0 ? (C[i] - L[i]) / range : 0.5;
          if (upperShadow > 1.5 * body && C[i] > 0 && upperShadow / C[i] > 0.03) flags.push('長上影');
          if (isNum(va[i]) && V[i] > 2 * va[i] && closePos < 0.4) flags.push('爆量收弱');
          for (let d = i - 2; d <= i; d++) {
            if (d < 20) continue;
            if (isNum(va[d]) && V[d] > 2.5 * va[d] && C[d] < O[d] && O[d] > 0 && Math.abs(C[d] - O[d]) / O[d] > 0.03) { flags.push('近期爆量長黑'); break; }
          }
          const flagged = flags.length > 0;

          // ── SOP 出場模擬（隔日開盤進、跌破停損收盤砍、最多 hold 日）──
          const { stop } = computeStop(C[i], L[i]);
          let exitIdx = e, broke = false;
          for (let d = 0; d < hold && e + d < n; d++) { exitIdx = e + d; if (C[e + d] < stop) { broke = true; break; } if (d === hold - 1) broke = false; }
          void broke;
          const ret = ((C[exitIdx] - base) / base) * 100;
          const changePct = i > 0 && C[i - 1] > 0 ? ((C[i] - C[i - 1]) / C[i - 1]) * 100 : 0;
          const tr: Trade = { ret, flagged, flags, changePct, date: candles[i].date, symbol };
          allTrades.push(tr); totalSignals++; used = true;
          const arr = byDate.get(tr.date); if (arr) arr.push(tr); else byDate.set(tr.date, [tr]);
        }
        if (used) stocksUsed++;
      } catch { /* skip */ }
    }
    if ((b / BATCH) % 5 === 0) console.log(`[avoid] 進度 ${Math.min(b + BATCH, universe.length)}/${universe.length}｜訊號 ${totalSignals}｜${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`[avoid] 完成：用 ${stocksUsed} 檔｜訊號 ${totalSignals}`);

  function stats(trades: Trade[]) {
    const n = trades.length;
    if (!n) return null;
    const net = trades.map(t => t.ret - COST_ROUNDTRIP);
    const wins = net.filter(r => r > 0), losses = net.filter(r => r <= 0);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    const avg = (a: number[]) => a.length ? sum(a) / a.length : 0;
    const pf = losses.length ? sum(wins) / Math.abs(sum(losses)) : Infinity;
    return { n, win: (wins.length / n) * 100, avgWin: avg(wins), avgLoss: avg(losses), pf, avgNet: avg(net) };
  }
  function row(name: string, st: ReturnType<typeof stats>) {
    if (!st) return `| ${name} | — | — | — | — | — | — |`;
    return `| ${name} | ${st.n} | ${st.win.toFixed(1)}% | +${st.avgWin.toFixed(2)}% | ${st.avgLoss.toFixed(2)}% | ${st.pf === Infinity ? '∞' : st.pf.toFixed(2)} | ${st.avgNet >= 0 ? '+' : ''}${st.avgNet.toFixed(2)}% |`;
  }

  const clean = allTrades.filter(t => !t.flagged);
  const flagged = allTrades.filter(t => t.flagged);
  // top3/日 子集（SOP 實際只買漲幅 top3）
  const top3: Trade[] = [];
  for (const [, arr] of byDate) top3.push(...[...arr].sort((a, b) => b.changePct - a.changePct).slice(0, 3));
  const top3Clean = top3.filter(t => !t.flagged), top3Flag = top3.filter(t => t.flagged);

  const lines: string[] = [];
  lines.push(`# 避雷層回測 — 「不能買的強股」驗證（TW，${stamp}）`);
  lines.push('');
  lines.push(`三色訊號 ${totalSignals} 筆｜用 ${stocksUsed} 檔｜出場=SOP(隔日開盤進/跌破停損收盤砍/最多${hold}日)｜扣費 ${COST_ROUNDTRIP}%`);
  lines.push(`避雷旗標(價量型,有2年歷史)：長上影 / 爆量收弱 / 近期爆量長黑`);
  lines.push('');
  lines.push('> ⚠️ 只測價量型避雷(融資/估值/大戶/節目缺2年歷史無法測)；存活偏差→看 CLEAN vs FLAGGED 相對差。');
  lines.push('');
  lines.push('## 全三色訊號：有旗標 vs 無旗標（避雷該讓 FLAGGED 明顯較差）');
  lines.push('');
  lines.push('| 桶 | n | 勝率 | 平均賺 | 平均賠 | 獲利因子PF | 每筆(扣費) |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  lines.push(row('全部(基準)', stats(allTrades)));
  lines.push(row('🟢 CLEAN 無避雷旗標', stats(clean)));
  lines.push(row('🔴 FLAGGED 中避雷旗標', stats(flagged)));
  lines.push(row('　└ 長上影', stats(allTrades.filter(t => t.flags.includes('長上影')))));
  lines.push(row('　└ 爆量收弱', stats(allTrades.filter(t => t.flags.includes('爆量收弱')))));
  lines.push(row('　└ 近期爆量長黑', stats(allTrades.filter(t => t.flags.includes('近期爆量長黑')))));
  lines.push('');
  lines.push('## SOP 實際版（每日漲幅 top3）：有旗標 vs 無旗標');
  lines.push('');
  lines.push('| 桶 | n | 勝率 | 平均賺 | 平均賠 | 獲利因子PF | 每筆(扣費) |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  lines.push(row('top3 全部', stats(top3)));
  lines.push(row('🟢 top3 CLEAN', stats(top3Clean)));
  lines.push(row('🔴 top3 FLAGGED', stats(top3Flag)));
  lines.push('');

  // 自動結論
  const c = stats(clean), f = stats(flagged);
  lines.push('## 自動結論（避雷層到底有沒有用）');
  lines.push('');
  if (c && f) {
    const pfGap = c.pf - f.pf;
    const netGap = c.avgNet - f.avgNet;
    lines.push(`- 🟢 CLEAN：PF ${c.pf.toFixed(2)}、每筆 ${c.avgNet >= 0 ? '+' : ''}${c.avgNet.toFixed(2)}%、勝率 ${c.win.toFixed(1)}%（n=${c.n}）`);
    lines.push(`- 🔴 FLAGGED：PF ${f.pf.toFixed(2)}、每筆 ${f.avgNet >= 0 ? '+' : ''}${f.avgNet.toFixed(2)}%、勝率 ${f.win.toFixed(1)}%（n=${f.n}）`);
    lines.push(`- **CLEAN − FLAGGED：PF 差 ${pfGap >= 0 ? '+' : ''}${pfGap.toFixed(2)}、每筆差 ${netGap >= 0 ? '+' : ''}${netGap.toFixed(2)}%**`);
    lines.push('');
    const verdict = pfGap > 0.15 && netGap > 0.3
      ? '✅ 避雷有用：帶旗標的明顯較差，過濾掉它們能拉高 PF/每筆 → 你的「不能買的強股」直覺對，daily-pick 該加價量避雷濾網。'
      : pfGap > 0
        ? '➖ 避雷方向對但幅度小：帶旗標的略差，過濾邊際價值有限。'
        : '❌ 避雷無效(甚至反向)：帶旗標的沒比較差，這些價量「危險訊號」在三色 context 下不構成可避的陷阱（與「高檔陰包陽實測是買訊」同調）。';
    lines.push(`> ${verdict}`);
  }
  lines.push('');

  const md = lines.join('\n');
  await fs.writeFile(path.join(outDir, `avoidance-backtest-${stamp}.md`), md + '\n');
  console.log('\n' + md);
  console.log(`\n📄 已寫入 ${path.join(outDir, `avoidance-backtest-${stamp}.md`)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
