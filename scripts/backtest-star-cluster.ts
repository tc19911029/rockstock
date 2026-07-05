/**
 * 批次B 大工程-5：群星/雙鴉/雙星 夜星延伸型態（CH2-08，2026-07-05）
 *
 * 課程投影片：夜星家族「左中長紅 + 中間 1~N 顆變盤線 + 右中長黑」，
 * 中間星越多（雙鴉=2小黑、群星=2~3+）空方控盤越久；高檔群星夜星右黑K跌破5均=多單馬上出。
 *
 * ⚠️ RESEARCH-ONLY 避雷側檢定：訊號後 D5/D20 是否系統性弱於同日宇宙（去 beta）。
 * ⚠️ 注意記憶 avoidance_layer_price_signals_reverse：價量型避雷回測常反向 — 若這裡也反向，
 *    只做「型態標示」不做避開建議。
 *
 * 判準（抄課程）：右=中長黑（實體≥2%）、中間連續 k 顆變盤線（實體<1.5%）、左=中長紅（實體≥2%）、
 * 高檔=左紅K收盤 ≥ 近40根最高收盤×0.92。分桶 k=1（傳統夜星）/ k=2（雙鴉·雙星）/ k≥3（群星）。
 */
import fs from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const FROM = '2024-07-01';
const HORIZONS = [5, 20] as const;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Obs { date: string; k: string; fwd: Record<number, number> }

function loadRaw(file: string): OHLC[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.candles ?? []);
    const norm = arr.map((c: Partial<OHLC>) => ({
      date: (c.date ?? '').slice(0, 10),
      open: +(c.open ?? 0), high: +(c.high ?? 0), low: +(c.low ?? 0),
      close: +(c.close ?? 0), volume: +(c.volume ?? 0),
    })).filter((c: OHLC) => c.date && c.close > 0 && c.open > 0);
    return norm.length >= 120 ? norm : null;
  } catch { return null; }
}
const bodyPct = (c: OHLC) => Math.abs(c.close - c.open) / c.open;

async function main() {
  const files = fs.readdirSync(C).filter(f => /^\d{4,6}\.(TW|TWO)\.json$/.test(f));
  const obs: Obs[] = [];

  for (const f of files) {
    const cs = loadRaw(path.join(C, f));
    if (!cs) continue;
    for (let t = 45; t + 20 < cs.length; t++) {
      const right = cs[t];
      if (right.date < FROM) continue;
      if (right.close * right.volume * 1000 < 50_000_000) continue;
      // 右：中長黑
      if (!(right.close < right.open && bodyPct(right) >= 0.02)) continue;
      // 中間：連續 k 顆變盤線（小實體 <1.5%）
      let k = 0;
      let i = t - 1;
      while (i > 0 && k < 6 && bodyPct(cs[i]) < 0.015) { k++; i--; }
      if (k < 1) continue;
      // 左：中長紅
      const left = cs[i];
      if (!(left.close > left.open && bodyPct(left) >= 0.02)) continue;
      // 高檔：左紅K收盤接近近40根最高收盤
      let hi = -Infinity;
      for (let j = Math.max(0, i - 40); j <= i; j++) if (cs[j].close > hi) hi = cs[j].close;
      if (left.close < hi * 0.92) continue;

      const fwd: Record<number, number> = {};
      for (const h of HORIZONS) fwd[h] = (cs[t + h].close / right.close - 1) * 100;
      obs.push({ date: right.date, k: k >= 3 ? 'k≥3群星' : k === 2 ? 'k=2雙鴉/雙星' : 'k=1夜星', fwd });
    }
  }

  obs.sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`夜星家族觸發 ${obs.length} 筆（${obs[0]?.date} ~ ${obs[obs.length - 1]?.date}）`);
  if (!obs.length) return;

  // 同日宇宙平均（以觸發樣本自身當宇宙不公平 → 用大盤 ^TWII 對齊即可）
  const twiiRaw = loadRaw(path.join(C, '^TWII.json'))!;
  const twii = new Map(twiiRaw.map(c => [c.date, c.close]));
  const twiiIdx = new Map(twiiRaw.map((c, i) => [c.date, i]));
  const excess = (o: Obs, h: number) => {
    const i0 = twiiIdx.get(o.date);
    if (i0 == null || i0 + h >= twiiRaw.length) return null;
    const a = twii.get(o.date)!, b = twiiRaw[i0 + h].close;
    return o.fwd[h] - (b - a) / a * 100;
  };

  const mid = obs[Math.floor(obs.length / 2)].date;
  const KS = ['k=1夜星', 'k=2雙鴉/雙星', 'k≥3群星'];
  for (const [seg, pool] of [['train', obs.filter(o => o.date < mid)], ['test ', obs.filter(o => o.date >= mid)]] as const) {
    console.log(`\n===== [${seg}] n=${pool.length}  分界 ${mid} =====`);
    console.log('星數桶'.padEnd(16) + 'n'.padStart(7) + 'D5超額'.padStart(9) + 'D20超額'.padStart(9) + 'D20勝率'.padStart(9));
    for (const kk of KS) {
      const rows = pool.filter(o => o.k === kk);
      if (rows.length < 30) { console.log(`${kk.padEnd(16)}${String(rows.length).padStart(7)}  (樣本<30)`); continue; }
      const cols = HORIZONS.map(h => {
        const xs = rows.map(o => excess(o, h)).filter((x): x is number => x != null);
        return xs.reduce((s, x) => s + x, 0) / xs.length;
      });
      const w = rows.map(o => excess(o, 20)).filter((x): x is number => x != null);
      const wr = w.filter(x => x > 0).length / w.length * 100;
      console.log(`${kk.padEnd(16)}${String(rows.length).padStart(7)}${cols.map(x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`.padStart(9)).join('')}${wr.toFixed(0).padStart(8)}%`);
    }
  }
  console.log('\n判讀：星數越多超額越負且 train/test 一致 → 群星值得做賣側顯示 detector；');
  console.log('      反向（訊號後反而更強）→ 對齊價量避雷反向記憶，只記錄不上線。');
}
main().catch(e => { console.error(e); process.exit(1); });
