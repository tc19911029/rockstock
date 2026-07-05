/**
 * 漲停隔日平盤補買回測（直播 QA 2026-07-01 Q17 / 知識點#12，2026-07-05）
 *
 * 課程原文：漲停掛單買不到 → 第二天原則不可追；唯一例外「第二天開在平盤附近
 * → 視同昨天買到」，進場守 −5% 停損；若開高 5~6% 絕不追（隔日沖賣壓）。
 *
 * 檢定：day T 收漲停（漲幅 ≥9.5% 且收在最高），day T+1 依開盤 gap 分桶進場
 * （T+1 開盤價買），看各桶 D5/D10/D20 絕對報酬 + 「守 −5% 停損」期望值。
 * 課程說法成立的樣子 = 平盤附近桶正期望、開高 ≥5% 桶明顯差（單調變壞）。
 * train/test 對半。絕對指標（賺多賠少），不比大盤。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const FROM = '2024-07-01';
const MIN_TURNOVER = 50_000_000; // 漲停日成交額 ≥5000萬（TW volume 單位=張 → ×1000）
const HORIZONS = [5, 10, 20] as const;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }

interface Obs {
  date: string;      // T+1（進場日）
  gapPct: number;    // T+1 開盤 vs T 收盤 %
  entry: number;     // T+1 open
  fwd: Record<number, number>; // N → close[t+N]/entry −1 (%)
  stopRet: number;   // 進場守 −5%（盤中觸價出，跳空以開盤價）持有 20 日報酬 %
}

function bucketOf(g: number): string {
  if (g < -3) return '開低<-3%';
  if (g < -1) return '開低-3~-1%';
  if (g <= 1) return '平盤附近±1%';
  if (g <= 3) return '開高1~3%';
  if (g <= 5) return '開高3~5%';
  if (g <= 7) return '開高5~7%(禁追)';
  return '開高>7%';
}
const BUCKET_ORDER = ['開低<-3%', '開低-3~-1%', '平盤附近±1%', '開高1~3%', '開高3~5%', '開高5~7%(禁追)', '開高>7%'];

async function main() {
  const files = (await fs.readdir(C)).filter(f => /^\d{4}\.(TW|TWO)\.json$/.test(f)); // 4碼個股，排除 ETF(00開頭5-6碼)
  const obs: Obs[] = [];

  for (const f of files) {
    if (f.startsWith('00')) continue; // ETF/受益憑證不做
    const cdl = await readJ(path.join(C, f)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0 && c.open > 0);
    if (cs.length < 60) continue;

    for (let t = 1; t + 1 + 20 < cs.length; t++) {
      if (cs[t].date < FROM) continue;
      const chg = cs[t].close / cs[t - 1].close - 1;
      // 收漲停：漲幅 ≥9.5% 且收在當日最高（鎖住）
      if (chg < 0.095 || cs[t].close < cs[t].high * 0.999) continue;
      if (cs[t].close * (cs[t].volume || 0) * 1000 < MIN_TURNOVER) continue;

      const e = t + 1;
      const entry = cs[e].open;
      const gapPct = (entry / cs[t].close - 1) * 100;

      const fwd: Record<number, number> = {};
      for (const h of HORIZONS) fwd[h] = (cs[t + h].close / entry - 1) * 100;

      // 守 −5%：進場日起 20 日內盤中 low ≤ entry×0.95 → 出在 min(當日open, 停損價)
      const stop = entry * 0.95;
      let stopRet: number | null = null;
      for (let d = e; d <= t + 20; d++) {
        const low = d === e ? Math.min(cs[d].low, entry) : cs[d].low; // 進場日以進場價之後計
        if (low <= stop) { stopRet = (Math.min(d === e ? stop : cs[d].open, stop) / entry - 1) * 100; break; }
      }
      if (stopRet == null) stopRet = (cs[t + 20].close / entry - 1) * 100;

      obs.push({ date: cs[e].date, gapPct, entry, fwd, stopRet });
    }
  }

  obs.sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`漲停隔日樣本 ${obs.length}（${obs[0]?.date} ~ ${obs[obs.length - 1]?.date}）`);
  const mid = obs[Math.floor(obs.length / 2)].date;

  for (const [name, pool] of [['train（前半）', obs.filter(o => o.date < mid)], ['test（後半）', obs.filter(o => o.date >= mid)]] as const) {
    console.log(`\n===== ${name}  n=${pool.length}  分界 ${mid} =====`);
    console.log('開盤gap桶          n      D5均     D10均    D20均    D20勝率  守-5%期望');
    for (const b of BUCKET_ORDER) {
      const rows = pool.filter(o => bucketOf(o.gapPct) === b);
      if (rows.length < 30) { console.log(`${b.padEnd(14)} ${String(rows.length).padStart(6)}  (樣本太少)`); continue; }
      const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
      const d = HORIZONS.map(h => mean(rows.map(o => o.fwd[h])));
      const win = rows.filter(o => o.fwd[20] > 0).length / rows.length * 100;
      const st = mean(rows.map(o => o.stopRet));
      console.log(
        `${b.padEnd(14)} ${String(rows.length).padStart(6)}  ` +
        d.map(x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(8)).join(' ') +
        `  ${win.toFixed(0)}%`.padStart(7) +
        `  ${st >= 0 ? '+' : ''}${st.toFixed(2)}%`.padStart(9),
      );
    }
  }
  console.log('\n判讀：課程說法成立 = 「平盤附近±1%」桶正期望且守-5%後仍正；開高越多越差（尤其 ≥5%）。');
}
main().catch(e => { console.error(e); process.exit(1); });
