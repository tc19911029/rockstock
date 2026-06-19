/**
 * C20 飆股「第二波」前置篩網 — 研究專用回測（進場-5）
 *
 * 書本（CH5-05 / 寶典「鎖第一波等第二波」）：做第二波前，要先有一段「凌厲強勢第一波」
 *   （初升段特性）：
 *     ① 上漲腳幅度大（書本講 2~4 倍；台股實務放寬到「一段噴出 ≥ X%」可調門檻）
 *     ② 四線多排（MA5>MA10>MA20>MA60，第一波期間均線多頭排列）
 *     ③ 連 ≥3 根大量長紅（trendAnalysis.ts hasConsecLongRed 的精神：紅K實體≥2% 且量≥前日×1.3）
 *     ④ 漲停（過前高）的強度（這裡用「單日漲幅 ≥ 9% 的根數」近似漲停）
 *     ⑤ 紅K不破5均（上漲腳期間沿5均，收盤跌破MA5 的次數很少）
 *   然後在「回後買上漲（B 軌近似底）」上加這層 strongFirstWave 前置篩網，
 *   看「先有強勢第一波的回後買」是不是真的比「一般回後買」前瞻報酬更好。
 *
 * ⚠️ 研究專用，production_touched = false：
 *   - 不 import 任何 production gate / detector，不改 applyPanelFilter、buyMethodTracks、
 *     MarketScanner、StrategyConfig，不碰 scan-parity。
 *   - B 軌近似底與既有 backtest-golden-pullback.ts 用「同一份裸 OHLC 重算」邏輯（位元相同口徑）。
 *   - strongFirstWave 純函式只活在本腳本，正式線位元不變。
 *
 * 北極星口徑（對齊 backtest-golden-pullback.ts / factor-grid-search.ts）：
 *   - 液態宇宙：每週成交額 top-500（.TW/.TWO，排除指數）。
 *   - 進場 = 訊號日「次一交易日(T+1)開盤」，持有 FWD 日收盤。
 *   - 超額 = 策略報酬 − 同窗 ^TWII 買入持有報酬。淨超額 = 超額 − 來回成本 0.585%。
 *   - train(前半)/test(後半) 依候選日中位數切；門檻多最易過擬合，樣本 <40 一律標不足、寧可 reject。
 *
 * 門檻多＝過擬合風險高：本腳本刻意把「第一波」拆成 5 個子條件各自可測 + 漸進收緊的
 *   組合（任一→全齊），用 train/test 同號當唯一通過條件，避免用全期最佳桶自我安慰。
 *
 * Usage:
 *   npx tsx scripts/backtest-wave2-prefilter.ts [FROM] [FWD]
 *   預設 FROM=2024-01-01 FWD=20
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const FROM = process.argv[2] || '2024-01-01';
const FWD = Number(process.argv[3] || 20);
const COST = 0.585; // 來回成本 %（對齊既有回測）

// 第一波回看窗：在「回後買底」往前找第一波（峰 + 上漲腳）
const WAVE_LOOKBACK = 45;   // 找第一波峰的回看窗（約 2 個月交易日）
const LEG_LOOKBACK = 50;    // 峰前找上漲腳起點的回看窗

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Wave {
  legGainPct: number;        // 第一波上漲腳幅度（峰/起點 −1）%
  fourLineDays: number;      // 第一波期間四線多排天數
  fourLineRatio: number;     // 四線多排天數 / 上漲腳長度
  consecLongRed: number;     // 最長連續大量長紅根數
  limitUpCount: number;      // 上漲腳期間單日 ≥9% 的根數（近似漲停過前高）
  breakMa5Count: number;     // 上漲腳期間收盤跌破 MA5 的根數（越少越「紅K不破5均」）
  legLen: number;            // 上漲腳長度（根）
}
interface Row {
  code: string; date: string; iso: string; turnover: number; excess: number;
  isPullbackBase: boolean;
  wave: Wave | null;
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
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 120) continue;
    const code = f.replace(/\.json$/, '');
    const close = cs.map(c => c.close);
    const ma = (t: number, n: number) => { if (t - n + 1 < 0) return NaN; let s = 0; for (let j = t - n + 1; j <= t; j++) s += close[j]; return s / n; };

    for (let t = LEG_LOOKBACK + WAVE_LOOKBACK + 5; t + 1 + FWD < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      const ma5 = ma(t, 5), ma20 = ma(t, 20), ma60 = ma(t, 60);
      if (!Number.isFinite(ma5) || !Number.isFinite(ma20) || !Number.isFinite(ma60)) continue;

      // 前瞻報酬（隔日開盤進、持有 FWD 日收盤）vs ^TWII
      const exitIdx = Math.min(t + 1 + FWD, cs.length - 1);
      const ret = (cs[exitIdx].close / cs[t + 1].open - 1) * 100; if (Math.abs(ret) > 80) continue;
      const e = twAt(cs[t + 1].date), x = twAt(cs[exitIdx].date);
      const mkt = (e >= 0 && x >= 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;

      // ── B 軌近似底（與 backtest-golden-pullback.ts 同口徑：多頭 + 近3根內站回MA5 + 今日續站）──
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

      // ── strongFirstWave：在底之前找「第一波」（峰 + 上漲腳）並度量五大強勢特徵 ──
      let wave: Wave | null = null;
      if (isPullbackBase) {
        // 第一波峰：回看 WAVE_LOOKBACK 根（但要在現在的回檔之前，故只看到 reclaimDay-3 之前）
        const peakEnd = Math.max(0, reclaimDay - 1);
        let peak = -Infinity, peakIdx = -1;
        for (let j = Math.max(0, peakEnd - WAVE_LOOKBACK); j <= peakEnd; j++) { if (cs[j].high > peak) { peak = cs[j].high; peakIdx = j; } }
        if (peakIdx >= 1) {
          // 上漲腳起點 = 峰之前 LEG_LOOKBACK 根內的最低 low 的位置
          let legStartVal = Infinity, legStartIdx = peakIdx;
          for (let j = Math.max(0, peakIdx - LEG_LOOKBACK); j <= peakIdx; j++) { if (cs[j].low < legStartVal) { legStartVal = cs[j].low; legStartIdx = j; } }
          const legLen = peakIdx - legStartIdx;
          if (legLen >= 3 && legStartVal > 0) {
            const legGainPct = (peak / legStartVal - 1) * 100;
            // 四線多排天數（上漲腳期間 MA5>MA10>MA20>MA60）
            let fourLineDays = 0;
            for (let j = legStartIdx; j <= peakIdx; j++) {
              const m5 = ma(j, 5), m10 = ma(j, 10), m20 = ma(j, 20), m60 = ma(j, 60);
              if (Number.isFinite(m5) && Number.isFinite(m10) && Number.isFinite(m20) && Number.isFinite(m60) && m5 > m10 && m10 > m20 && m20 > m60) fourLineDays++;
            }
            // 連續大量長紅（紅K實體≥2% 且量≥前日×1.3）最長連續根數
            let consecLongRed = 0, run = 0;
            for (let j = legStartIdx; j <= peakIdx; j++) {
              const c = cs[j], p = cs[j - 1];
              const body = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
              const longRed = c.close > c.open && body >= 0.02;
              const bigVol = p && p.volume > 0 ? c.volume >= p.volume * 1.3 : false;
              if (longRed && bigVol) { run++; if (run > consecLongRed) consecLongRed = run; } else run = 0;
            }
            // 漲停近似：上漲腳期間單日漲幅 ≥9% 的根數
            let limitUpCount = 0;
            for (let j = legStartIdx; j <= peakIdx; j++) { const p = cs[j - 1]; if (p && p.close > 0 && (cs[j].close / p.close - 1) >= 0.09) limitUpCount++; }
            // 紅K不破5均：上漲腳期間收盤跌破 MA5 的根數（越少越強）
            let breakMa5Count = 0;
            for (let j = legStartIdx; j <= peakIdx; j++) { const m5 = ma(j, 5); if (Number.isFinite(m5) && cs[j].close < m5) breakMa5Count++; }
            wave = { legGainPct, fourLineDays, fourLineRatio: fourLineDays / Math.max(1, legLen + 1), consecLongRed, limitUpCount, breakMa5Count, legLen };
          }
        }
      }

      all.push({
        code, date: cs[t].date, iso: isoWeek(cs[t].date), turnover: cs[t].close * (cs[t].volume || 0),
        excess: ret - mkt, isPullbackBase, wave,
      });
    }
  }

  // 每週成交額 top-500 液態宇宙
  const byW = new Map<string, Row[]>();
  for (const r of all) { let a = byW.get(r.iso); if (!a) { a = []; byW.set(r.iso, a); } a.push(r); }
  const liq: Row[] = [];
  for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  if (liq.length < 100) { console.log('液態樣本太少，abort'); return; }
  const mid = liq[Math.floor(liq.length / 2)].date;
  const train = liq.filter(r => r.date < mid), test = liq.filter(r => r.date >= mid);
  console.log(`液態 ${liq.length} 筆 | train ${train.length}(${liq[0].date}~) | test ${test.length}(${mid}~)`);
  console.log(`成本 ${COST}%；淨超額=平均超額−成本；進場=隔日開盤 持有${FWD}日 對^TWII\n`);

  // 基準：所有「B 軌近似底（回後買上漲）」
  const base = liq.filter(r => r.isPullbackBase);
  const baseTr = train.filter(r => r.isPullbackBase);
  const baseTe = test.filter(r => r.isPullbackBase);
  const b0 = agg(base), b0t = agg(baseTr), b0e = agg(baseTe);
  console.log('========== 基準：B 軌近似底（回後買上漲，無前置篩網）==========');
  console.log(`  全部 淨 ${fmt(b0.net)}%/勝${b0.win.toFixed(0)}%(${b0.n})  train 淨 ${fmt(b0t.net)}%(${b0t.n})  test 淨 ${fmt(b0e.net)}%(${b0e.n})\n`);

  function report(label: string, pred: (w: Wave) => boolean) {
    const fa = agg(base.filter(r => r.wave && pred(r.wave)));
    const ta = agg(baseTr.filter(r => r.wave && pred(r.wave)));
    const ea = agg(baseTe.filter(r => r.wave && pred(r.wave)));
    // 通過 = train/test 都正、都 ≥40 樣本，且至少不輸基準（兩段都 > 各自基準淨超額）
    let verdict: string;
    if (ta.n < 40 || ea.n < 40) verdict = '樣本不足';
    else if (ta.net > 0 && ea.net > 0 && ta.net > b0t.net && ea.net > b0e.net) verdict = '✅train/test都贏基準';
    else if ((ta.net > 0) !== (ea.net > 0)) verdict = '⚠️train/test翻號';
    else if (ta.net <= 0 && ea.net <= 0) verdict = '一致負';
    else verdict = '不穩/沒贏基準';
    const liftT = ta.net - b0t.net, liftE = ea.net - b0e.net;
    console.log(`  ${label.padEnd(26)} 全 ${fmt(fa.net)}%/${fa.win.toFixed(0)}%(${fa.n})`.padEnd(52) +
      ` tr ${fmt(ta.net)}%(${ta.n}) te ${fmt(ea.net)}%(${ea.n})`.padEnd(30) +
      ` lift tr${fmt(liftT)}/te${fmt(liftE)}pp ${verdict}`);
  }

  console.log('========== 五大子條件各自當前置篩網（看哪個有 lift）==========');
  report('①上漲腳 ≥30%', w => w.legGainPct >= 30);
  report('①上漲腳 ≥50%', w => w.legGainPct >= 50);
  report('①上漲腳 ≥80%', w => w.legGainPct >= 80);
  report('②四線多排比 ≥0.5', w => w.fourLineRatio >= 0.5);
  report('②四線多排比 ≥0.7', w => w.fourLineRatio >= 0.7);
  report('③連大量長紅 ≥3', w => w.consecLongRed >= 3);
  report('③連大量長紅 ≥2', w => w.consecLongRed >= 2);
  report('④漲停根數 ≥1', w => w.limitUpCount >= 1);
  report('④漲停根數 ≥2', w => w.limitUpCount >= 2);
  report('⑤幾乎不破5均(破≤2根)', w => w.breakMa5Count <= 2);

  console.log('\n========== 組合前置篩網（漸進收緊；門檻越多越易過擬合）==========');
  // 寬：強勢一波（腳≥30% 且 連長紅≥2 且 四線多排比≥0.5）
  report('寬: 腳≥30 ∧ 連紅≥2 ∧ 四線≥0.5', w => w.legGainPct >= 30 && w.consecLongRed >= 2 && w.fourLineRatio >= 0.5);
  // 中：加漲停過前高（腳≥50% 且 連長紅≥3 且 四線≥0.5 且 漲停≥1）
  report('中: 腳≥50 ∧ 連紅≥3 ∧ 四線≥0.5 ∧ 漲停≥1', w => w.legGainPct >= 50 && w.consecLongRed >= 3 && w.fourLineRatio >= 0.5 && w.limitUpCount >= 1);
  // 嚴：書本全齊近似（腳≥50 ∧ 連紅≥3 ∧ 四線≥0.7 ∧ 漲停≥1 ∧ 幾乎不破5均）
  report('嚴: 書本全齊近似', w => w.legGainPct >= 50 && w.consecLongRed >= 3 && w.fourLineRatio >= 0.7 && w.limitUpCount >= 1 && w.breakMa5Count <= 3);

  // 排序因子視角：在底內依「第一波強度分數」排序，前1/3 vs 後1/3
  console.log('\n========== 排序視角：底內依第一波強度排序 前1/3(最強) vs 後1/3(最弱) ==========');
  function strength(w: Wave | null) {
    if (!w) return -1;
    // 簡單線性合成（純研究，不進生產）：腳幅度 + 四線比 + 連紅 + 漲停 − 破5均
    return w.legGainPct * 0.5 + w.fourLineRatio * 30 + w.consecLongRed * 5 + w.limitUpCount * 5 - w.breakMa5Count * 2;
  }
  function thirds(rows: Row[], label: string) {
    const s = rows.filter(r => r.wave).map(r => ({ r, s: strength(r.wave) })).sort((a, b) => b.s - a.s).map(x => x.r);
    const k = Math.floor(s.length / 3);
    if (k < 20) { console.log(`  ${label}: 樣本不足 (${s.length})`); return; }
    const top = agg(s.slice(0, k)), bot = agg(s.slice(-k));
    console.log(`  ${label.padEnd(8)} 最強1/3 淨 ${fmt(top.net)}%/勝${top.win.toFixed(0)}%(${top.n})  |  最弱1/3 淨 ${fmt(bot.net)}%/勝${bot.win.toFixed(0)}%(${bot.n})  |  強−弱 ${fmt(top.net - bot.net)}pp`);
  }
  thirds(base, '全部'); thirds(baseTr, 'train'); thirds(baseTe, 'test');

  console.log('\n判讀：書本宣稱「先有強勢第一波的回後買更好」⇒ 應看到 lift>0 且 train/test 同號、贏基準。');
  console.log('門檻多最易過擬合：只認「train/test 都贏基準」當有 edge，否則 reject。');
}
main().catch(e => { console.error(e); process.exit(1); });
