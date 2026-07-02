/**
 * C15 黃金分割回檔深度 — 研究專用回測（進場-6）
 *
 * 書本經驗法則（CH6-2 / CH1-09）：「回後買上漲，回檔幅度小的優先」，
 * 用黃金分割率 0.318 / 0.5 / 0.682 把回檔強弱分級。回檔淺＝主力惜售＝強勢，
 * 回檔深＝弱勢。本腳本驗證「回檔深度比」當排序/分桶因子有沒有真 edge。
 *
 * ⚠️ 研究專用：不 import 任何 production gate，不改 applyPanelFilter 排序、
 *    不改 detectPullbackBuy。只在這裡用裸 OHLC 重算回檔深度比做對照。
 *    production_touched = false。
 *
 * 方法（對齊 factor-grid-search.ts 既有慣例）：
 *  - 全市場台股 candle（.TW/.TWO）、每週各取成交額 top-500 當液態宇宙。
 *  - 候選日 = 「站回 MA5 的多頭回後買」近似底（pullbackBase），在這底上比較回檔深度桶。
 *  - 進場 = 訊號日次一交易日(T+1)開盤，持有 20 日，對 ^TWII 算超額。
 *  - 淨超額 = 平均超額 − 來回成本 0.585%。
 *  - train(前半)/test(後半) 依候選日中位數切；只看樣本 ≥40 的桶。
 *
 * 回檔深度比定義（純價格、可即時算）：
 *  - 在 index 回看 LOOKBACK 根，找最高 high 當「波段峰」peak（上漲腳終點）。
 *  - 峰之前再回看，找這段上漲腳的起點 legStart（峰前的最低 low）。
 *  - 回檔低 pullbackLow = 峰之後到今天的最低 low。
 *  - depthRatio = (peak − pullbackLow) / (peak − legStart)   （0=沒回, 1=全吐回）
 *  - 黃金分割分桶：淺 ≤0.318 / 中 0.318~0.5 / 深 0.5~0.682 / 過深 >0.682
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const FROM = '2024-07-20';
const FWD = 20;
const COST = 0.585; // 來回成本 %（對齊既有回測）
const LOOKBACK = 30; // 找波段峰的回看窗
const LEG_LOOKBACK = 40; // 峰前找上漲腳起點的回看窗

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Row {
  date: string; iso: string; turnover: number; excess: number;
  isPullbackBase: boolean;
  depthRatio: number | null;   // 回檔深度比
  pullbackDays: number;        // 連續 close<MA5 天數（rockstock 現狀近似）
  legGainPct: number;          // 上漲腳幅度（峰/起點 −1）
}
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }

function agg(rows: Row[]) {
  if (rows.length === 0) return { ex: 0, net: 0, win: 0, n: 0 };
  const ex = rows.reduce((s, r) => s + r.excess, 0) / rows.length;
  const win = 100 * rows.filter(r => r.excess - COST > 0).length / rows.length;
  return { ex, net: ex - COST, win, n: rows.length };
}
const fmt = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);

async function main() {
  const twiiRaw = await readJ(path.join(C, '^TWII.json'));
  const twii: OHLC[] = twiiRaw.candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };

  const files = (await fs.readdir(C)).filter(f => /\.(TW|TWO)\.json$/.test(f) && !f.startsWith('^'));
  const all: Row[] = [];

  for (const f of files) {
    const cdl = await readJ(path.join(C, f)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 80) continue;
    const close = cs.map(c => c.close);
    const ma = (t: number, n: number) => { if (t - n + 1 < 0) return NaN; let s = 0; for (let j = t - n + 1; j <= t; j++) s += close[j]; return s / n; };

    for (let t = LEG_LOOKBACK + 5; t + 1 + FWD < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      const ma5 = ma(t, 5), ma20 = ma(t, 20), ma60 = ma(t, 60);
      if (!Number.isFinite(ma5) || !Number.isFinite(ma20) || !Number.isFinite(ma60)) continue;

      // 前瞻報酬（隔日開盤進、持有 FWD 日收盤）vs ^TWII
      const exitIdx = Math.min(t + 1 + FWD, cs.length - 1);
      const ret = (cs[exitIdx].close / cs[t + 1].open - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[exitIdx].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;

      // ── 多頭回後買近似底（鏡像 detectPullbackBuy 精神：多頭 + 近 3 根內站回 MA5 + 今日續站 MA5）──
      const trendUp = ma5 > ma20 && ma20 > ma60 && cs[t].close > ma20;
      let reclaimDay = -1;
      for (let j = Math.max(1, t - 2); j <= t; j++) {
        const pj = ma(j, 5), pjPrev = ma(j - 1, 5);
        if (!Number.isFinite(pj) || !Number.isFinite(pjPrev)) continue;
        if (cs[j - 1].close < pjPrev && cs[j].close >= pj) { reclaimDay = j; break; }
      }
      let reclaimOk = reclaimDay >= 0;
      if (reclaimOk) for (let kk = reclaimDay; kk <= t; kk++) { const mk = ma(kk, 5); if (!Number.isFinite(mk) || cs[kk].close < mk) { reclaimOk = false; break; } }
      const isPullbackBase = trendUp && reclaimOk;

      // 回檔天數（連續 close<MA5）
      let pullbackDays = 0;
      if (reclaimDay >= 1) for (let i = reclaimDay - 1; i >= Math.max(0, reclaimDay - 20); i--) { const mk = ma(i, 5); if (!Number.isFinite(mk) || cs[i].close >= mk) break; pullbackDays++; }

      // ── 回檔深度比 ──
      let depthRatio: number | null = null, legGainPct = 0;
      // 波段峰 = 回看 LOOKBACK 根的最高 high 及其位置
      let peak = -Infinity, peakIdx = -1;
      for (let j = Math.max(0, t - LOOKBACK); j <= t; j++) { if (cs[j].high > peak) { peak = cs[j].high; peakIdx = j; } }
      if (peakIdx >= 0) {
        // 上漲腳起點 = 峰之前 LEG_LOOKBACK 根內的最低 low
        let legStart = Infinity;
        for (let j = Math.max(0, peakIdx - LEG_LOOKBACK); j <= peakIdx; j++) { if (cs[j].low < legStart) legStart = cs[j].low; }
        // 回檔低 = 峰之後到今天的最低 low
        let pbLow = Infinity;
        for (let j = peakIdx; j <= t; j++) { if (cs[j].low < pbLow) pbLow = cs[j].low; }
        const legRange = peak - legStart;
        if (legRange > 0 && peak > pbLow) {
          depthRatio = (peak - pbLow) / legRange;
          legGainPct = (peak / legStart - 1) * 100;
        }
      }

      all.push({
        date: cs[t].date, iso: isoWeek(cs[t].date), turnover: cs[t].close * (cs[t].volume || 0),
        excess: ret - mkt, isPullbackBase, depthRatio, pullbackDays, legGainPct,
      });
    }
  }

  // 每週成交額 top-500 液態宇宙
  const byW = new Map<string, Row[]>();
  for (const r of all) { let a = byW.get(r.iso); if (!a) { a = []; byW.set(r.iso, a); } a.push(r); }
  const liq: Row[] = [];
  for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  const mid = liq[Math.floor(liq.length / 2)].date;
  const train = liq.filter(r => r.date < mid), test = liq.filter(r => r.date >= mid);
  console.log(`液態 ${liq.length} 筆 | train ${train.length}(${liq[0].date}~) | test ${test.length}(${mid}~)`);
  console.log(`成本 ${COST}%；淨超額=平均超額−成本；進場=隔日開盤 持有${FWD}日 對^TWII\n`);

  // 只看「多頭回後買近似底」內的回檔深度桶（最貼書本語境）
  const base = liq.filter(r => r.isPullbackBase && r.depthRatio != null);
  const baseTr = train.filter(r => r.isPullbackBase && r.depthRatio != null);
  const baseTe = test.filter(r => r.isPullbackBase && r.depthRatio != null);
  console.log(`【回後買近似底】全部 ${base.length} / train ${baseTr.length} / test ${baseTe.length}`);
  const a0 = agg(base);
  console.log(`  全底基準：超額 ${fmt(a0.ex)}% 淨 ${fmt(a0.net)}% 勝率 ${a0.win.toFixed(0)}%\n`);

  const buckets: [string, (d: number) => boolean][] = [
    ['淺回 ≤0.318', d => d <= 0.318],
    ['中回 0.318~0.5', d => d > 0.318 && d <= 0.5],
    ['深回 0.5~0.682', d => d > 0.5 && d <= 0.682],
    ['過深 >0.682', d => d > 0.682],
  ];
  console.log('========== 回後買底 × 回檔深度桶（看「淺回是否真的較好」）==========');
  console.log('桶                全部 淨超額/勝(n)        train 淨/勝       test 淨/勝       一致?');
  for (const [name, pred] of buckets) {
    const fa = agg(base.filter(r => pred(r.depthRatio!)));
    const ta = agg(baseTr.filter(r => pred(r.depthRatio!)));
    const ea = agg(baseTe.filter(r => pred(r.depthRatio!)));
    const consistent = (ta.net > 0) === (ea.net > 0) && ta.n >= 40 && ea.n >= 40 ? (ta.net > 0 ? '✅都正' : '一致負') : '樣本不足/翻號';
    console.log(`  ${name.padEnd(16)} ${fmt(fa.net)}%/${fa.win.toFixed(0)}%(${fa.n})`.padEnd(44) +
      ` ${fmt(ta.net)}%/${ta.win.toFixed(0)}%(${ta.n})`.padEnd(20) +
      ` ${fmt(ea.net)}%/${ea.win.toFixed(0)}%(${ea.n})`.padEnd(20) + ` ${consistent}`);
  }

  // 排序因子驗證：在底內「依回檔深度比由淺到深排序」取前 1/3 vs 後 1/3，看前瞻報酬有沒有單調分層
  console.log('\n========== 排序因子：底內依回檔深度比排序 前1/3(最淺) vs 後1/3(最深) ==========');
  function thirds(rows: Row[], label: string) {
    const s = [...rows].sort((a, b) => (a.depthRatio! - b.depthRatio!));
    const k = Math.floor(s.length / 3);
    if (k < 20) { console.log(`  ${label}: 樣本不足 (${s.length})`); return; }
    const top = agg(s.slice(0, k)), bot = agg(s.slice(-k));
    console.log(`  ${label.padEnd(8)} 最淺1/3 淨 ${fmt(top.net)}%/勝${top.win.toFixed(0)}%(${top.n})  |  最深1/3 淨 ${fmt(bot.net)}%/勝${bot.win.toFixed(0)}%(${bot.n})  |  淺−深 ${fmt(top.net - bot.net)}pp`);
  }
  thirds(base, '全部');
  thirds(baseTr, 'train');
  thirds(baseTe, 'test');

  // 對照：rockstock 現狀近似（回檔天數越少越好）也順手分層，看深度比有沒有比天數更有鑑別力
  console.log('\n========== 對照：底內依「回檔天數」(現狀近似) 分層 短(≤3天) vs 長(≥6天) ==========');
  function daysSplit(rows: Row[], label: string) {
    const sh = agg(rows.filter(r => r.pullbackDays <= 3));
    const lo = agg(rows.filter(r => r.pullbackDays >= 6));
    console.log(`  ${label.padEnd(8)} 短回 淨 ${fmt(sh.net)}%/勝${sh.win.toFixed(0)}%(${sh.n})  |  長回 淨 ${fmt(lo.net)}%/勝${lo.win.toFixed(0)}%(${lo.n})  |  短−長 ${fmt(sh.net - lo.net)}pp`);
  }
  daysSplit(base, '全部'); daysSplit(baseTr, 'train'); daysSplit(baseTe, 'test');

  console.log('\n判讀：書本宣稱「回檔淺優先」⇒ 應看到「淺回桶 淨超額 > 深回桶」且 train/test 同號。');
}
main().catch(e => { console.error(e); process.exit(1); });
