/**
 * 批次C：做空 7 進場位置誠實回測（2026-07-05）
 *
 * 兩個口徑：
 *  A. 課程紀律模擬（絕對報酬）：T+1 開盤空 → 盤中觸進場黑K最高點=停損回補 →
 *     收盤站上 MA5=回補（課程共同紀律）→ 最多 40 天。成本 0.85%（券商費×2+證交稅+借券費近似）。
 *  B. 固定視窗（市場中立）：short alpha = −(個股 − ^TWII) − 成本，D5/D20。
 *
 * 分桶：S1~S7 各位置 × train/test；另按 hasVolume 拆（S1/S5 課程量不要求）。
 * 裁決：某位置兩段紀律模擬期望為正（或 short alpha 穩定正）→ 才考慮開軌接掃描；
 *       否則 = 走圖顯示層 only。
 */
import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { detectShortEntries } from '@/lib/analysis/shortEntries';

const C = path.join(process.cwd(), 'data/candles/TW');
const FROM = '2024-07-01';
const MAXHOLD = 40;
const COST_SHORT = 0.85;
const HOLDS = [5, 20] as const;

const argLimit = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = argLimit ? parseInt(argLimit.split('=')[1], 10) : Infinity;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Hit {
  date: string; pos: number; hasVolume: boolean;
  disc: { ret: number; days: number } | null;       // 課程紀律模擬（空單絕對報酬%）
  alpha: Record<number, number | null>;             // 固定視窗 short alpha
}

function loadRaw(file: string): Candle[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.candles ?? []);
    const norm: Candle[] = arr.map((c: Partial<Candle>) => ({
      date: (c.date ?? '').slice(0, 10),
      open: +(c.open ?? 0), high: +(c.high ?? 0), low: +(c.low ?? 0),
      close: +(c.close ?? 0), volume: +(c.volume ?? 0),
    })).filter((c: Candle) => c.date && c.close > 0 && c.open > 0);
    return norm.length >= 120 ? norm : null;
  } catch { return null; }
}

/** 課程紀律模擬：T+1 開盤空，停損=訊號黑K高點（盤中觸價回補），收盤>MA5 回補 */
function disciplineSim(cs: Candle[], sig: number, stop: number): { ret: number; days: number } | null {
  const e = sig + 1;
  if (e >= cs.length || cs[e].open <= 0) return null;
  const entry = cs[e].open;
  const end = Math.min(e + MAXHOLD, cs.length - 1);
  const ma5 = (i: number) => { if (i < 4) return 0; let s = 0; for (let k = i - 4; k <= i; k++) s += cs[k].close; return s / 5; };
  for (let d = e; d <= end; d++) {
    // 停損：盤中觸進場黑K最高點（開盤跳過停損用開盤價）
    if (cs[d].high >= stop) {
      const px = Math.max(cs[d].open, stop);
      return { ret: (entry - px) / entry * 100 - COST_SHORT, days: d - e };
    }
    // 回補：收盤站上 5 均（進場日不算，至少走一天）
    if (d > e) {
      const m = ma5(d);
      if (m > 0 && cs[d].close > m) return { ret: (entry - cs[d].close) / entry * 100 - COST_SHORT, days: d - e };
    }
  }
  return { ret: (entry - cs[end].close) / entry * 100 - COST_SHORT, days: end - e };
}

function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
const fmt = (x: number) => (isNaN(x) ? '   n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`).padStart(8);

async function main() {
  const twiiRaw = loadRaw(path.join(C, '^TWII.json'))!;
  const twii = new Map(twiiRaw.map(c => [c.date, c.close]));

  const files = fs.readdirSync(C).filter(f => /^\d{4,6}\.(TW|TWO)\.json$/.test(f)).slice(0, LIMIT);
  const hits: Hit[] = [];
  let done = 0;

  for (const f of files) {
    const raw = loadRaw(path.join(C, f));
    if (!raw) continue;
    const ci = computeIndicators(raw);
    for (let idx = 60; idx + 2 < ci.length; idx++) {
      const c = ci[idx];
      if (c.date < FROM) continue;
      if (c.close >= c.open) continue;                            // 便宜前置：黑K
      if (c.close * c.volume * 1000 < 50_000_000) continue;       // 液態地板
      const sigs = detectShortEntries(ci, idx);
      if (!sigs.length) continue;
      for (const s of sigs) {
        const alpha: Record<number, number | null> = {};
        for (const h of HOLDS) {
          if (idx + h >= raw.length) { alpha[h] = null; continue; }
          const e1 = raw[idx + 1].open;
          const a = twii.get(raw[idx + 1].date), b = twii.get(raw[idx + h].date);
          alpha[h] = e1 > 0 && a != null && b != null
            ? -((raw[idx + h].close - e1) / e1 * 100 - (b - a) / a * 100) - COST_SHORT
            : null;
        }
        hits.push({ date: c.date, pos: s.position, hasVolume: s.hasVolume, disc: disciplineSim(raw, idx, s.stopLoss), alpha });
      }
    }
    if (++done % 400 === 0) console.log(`  ...${done}/${files.length}`);
  }

  hits.sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`\n做空進場訊號 ${hits.length} 筆（${hits[0]?.date} ~ ${hits[hits.length - 1]?.date}）`);
  if (!hits.length) return;
  const mid = hits[Math.floor(hits.length / 2)].date;
  const NAMES: Record<number, string> = {
    1: 'S1 彈後空', 2: 'S2 盤整跌破', 3: 'S3 橫盤跌破', 4: 'S4 頂部型態',
    5: 'S5 ABC切線', 6: 'S6 軌道線', 7: 'S7 飆股反彈破',
  };

  for (const [seg, pool] of [['train', hits.filter(h => h.date < mid)], ['test ', hits.filter(h => h.date >= mid)]] as const) {
    console.log(`\n===== [${seg}] n=${pool.length}  分界 ${mid} =====`);
    console.log('位置'.padEnd(14) + 'n'.padStart(6) + '紀律期望'.padStart(9) + '紀律勝率'.padStart(9) + '平均賠'.padStart(8) + '最大賠'.padStart(8) + 'αD5'.padStart(8) + 'αD20'.padStart(8));
    for (let p = 1; p <= 7; p++) {
      const rows = pool.filter(h => h.pos === p);
      if (rows.length < 25) { console.log(`${NAMES[p].padEnd(14)}${String(rows.length).padStart(6)}  (樣本<25)`); continue; }
      const disc = rows.map(h => h.disc).filter((x): x is { ret: number; days: number } => x != null);
      const dr = disc.map(d => d.ret);
      const wr = dr.filter(x => x > 0).length / dr.length * 100;
      const lose = dr.filter(x => x <= 0);
      const a5 = mean(rows.map(h => h.alpha[5]).filter((x): x is number => x != null));
      const a20 = mean(rows.map(h => h.alpha[20]).filter((x): x is number => x != null));
      console.log(
        `${NAMES[p].padEnd(14)}${String(rows.length).padStart(6)}${fmt(mean(dr))}${wr.toFixed(0).padStart(8)}%` +
        `${fmt(mean(lose))}${fmt(Math.min(...dr))}${fmt(a5)}${fmt(a20)}`,
      );
    }
    // 量拆桶（S1/S5 課程量不要求 → 看有量是否更強）
    for (const p of [1, 5]) {
      const withV = pool.filter(h => h.pos === p && h.hasVolume);
      const noV = pool.filter(h => h.pos === p && !h.hasVolume);
      if (withV.length >= 25 && noV.length >= 25) {
        const m = (rs: Hit[]) => mean(rs.map(h => h.disc?.ret).filter((x): x is number => x != null));
        console.log(`  ${NAMES[p]} 量拆：有量 n=${withV.length} 期望${fmt(m(withV))} ｜ 無量 n=${noV.length} 期望${fmt(m(noV))}`);
      }
    }
  }
  console.log('\n判讀：某位置 train/test 紀律期望皆正（或 αD20 穩定正）→ 候選開軌；否則走圖顯示層 only。');
}
main().catch(e => { console.error(e); process.exit(1); });
