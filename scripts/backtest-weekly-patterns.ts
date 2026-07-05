/**
 * 批次B 回測-13：週線六型態（2026-07-05）
 *
 * 課程 CH6-4 投影片第 5 點：「日線型態進場的 K 線訊號是操作短線的買進位置；
 * 週線型態進場的 K 線訊號是操作中長線的買進位置。」現況只有週線 W 底（N_weeklyW）。
 *
 * ⚠️ RESEARCH-ONLY：把生產 detectLetterN（8 種底部型態）跑在**週K**上（aggregateCandles '1wk'
 * + computeIndicators，MA5=5週線＝書本週線轉折波口徑），訊號=完成週的週五，進場=次一交易日開盤。
 * 週線語意=中長線 → 看 D5/D20/D60 淨超額（−^TWII −0.55% 成本）。
 * 過誠實 edge（train/test 同號正）才生產化為 N_weeklyX 子型態。
 */
import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { detectLetterN } from '@/lib/analysis/v12LetterN';
import { aggregateCandles } from '@/lib/datasource/aggregateCandles';

const C = path.join(process.cwd(), 'data/candles/TW');
const COST = 0.55;
const HOLDS = [5, 20, 60] as const;
const MIN_T0 = '2023-06-01';

function loadRaw(file: string): Candle[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.candles ?? []);
    const norm: Candle[] = arr.map((c: Partial<Candle>) => ({
      date: (c.date ?? '').slice(0, 10),
      open: +(c.open ?? 0), high: +(c.high ?? 0), low: +(c.low ?? 0),
      close: +(c.close ?? 0), volume: +(c.volume ?? 0),
    })).filter((c: Candle) => c.date && c.close > 0);
    return norm.length >= 300 ? norm : null;
  } catch { return null; }
}

function weekMonday(date: string): string {
  const dt = new Date(date + 'T00:00:00Z');
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day);
  return dt.toISOString().slice(0, 10);
}

interface Hit { date: string; pattern: string; excess: Record<number, number | null> }
function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
function win(a: number[]) { return a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN; }
const fmt = (x: number) => (isNaN(x) ? '   n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`).padStart(8);

async function main() {
  const twiiRaw = loadRaw(path.join(C, '^TWII.json'));
  if (!twiiRaw) throw new Error('^TWII missing');
  const twii = new Map(twiiRaw.map(c => [c.date, c.close]));

  const files = fs.readdirSync(C).filter(f => /^\d{4,6}\.(TW|TWO)\.json$/.test(f));
  const hits: Hit[] = [];
  let done = 0;

  for (const f of files) {
    const daily = loadRaw(path.join(C, f));
    if (!daily) continue;
    const code = f.split('.')[0];

    // 週K + 指標（MA5=5週線）；最後一週可能不完整 → 不當訊號週
    const weekly = aggregateCandles(daily, '1wk');
    if (weekly.length < 40) continue;
    const wci = computeIndicators(weekly);

    // 週 → 該週最後一個日K index
    const lastDailyIdxOfWeek = new Map<string, number>();
    daily.forEach((c, i) => lastDailyIdxOfWeek.set(weekMonday(c.date), i));

    for (let w = 30; w < wci.length - 1; w++) {   // -1 = 排除最後（潛在不完整）週
      const r = detectLetterN(wci, w, 'TW', code);
      if (!r.triggered || !r.patternType) continue;
      const dIdx = lastDailyIdxOfWeek.get(weekMonday(wci[w].date));
      if (dIdx == null || dIdx + 1 >= daily.length) continue;
      const t0 = daily[dIdx];
      if (t0.date < MIN_T0) continue;
      if (t0.close * t0.volume * 1000 < 50_000_000) continue;   // 液態地板 5000 萬

      const entry = daily[dIdx + 1]?.open;
      if (!entry || entry <= 0) continue;
      const excess: Record<number, number | null> = {};
      for (const h of HOLDS) {
        const exitBar = daily[dIdx + h];
        if (!exitBar) { excess[h] = null; continue; }
        const a = twii.get(daily[dIdx + 1].date), b = twii.get(exitBar.date);
        excess[h] = a != null && b != null && a > 0
          ? (exitBar.close - entry) / entry * 100 - (b - a) / a * 100 - COST
          : null;
      }
      hits.push({ date: t0.date, pattern: r.patternType, excess });
    }
    if (++done % 400 === 0) console.log(`  ...${done}/${files.length}`);
  }

  hits.sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`\n週線型態訊號 ${hits.length} 筆（${hits[0]?.date} ~ ${hits[hits.length - 1]?.date}）`);
  if (!hits.length) return;
  const mid = hits[Math.floor(hits.length / 2)].date;

  const types = [...new Set(hits.map(h => h.pattern))];
  for (const [seg, pool] of [['train', hits.filter(h => h.date < mid)], ['test ', hits.filter(h => h.date >= mid)]] as const) {
    console.log(`\n===== [${seg}] n=${pool.length}  分界 ${mid} =====`);
    console.log('型態'.padEnd(22) + 'n'.padStart(6) + 'D5淨超額'.padStart(10) + 'D20淨超額'.padStart(10) + 'D60淨超額'.padStart(10) + 'D60勝率'.padStart(9));
    for (const t of ['ALL', ...types]) {
      const rows = t === 'ALL' ? pool : pool.filter(h => h.pattern === t);
      if (rows.length < 20) { console.log(`${t.padEnd(22)}${String(rows.length).padStart(6)}  (樣本<20)`); continue; }
      const cols = HOLDS.map(h => mean(rows.map(r => r.excess[h]).filter((x): x is number => x != null)));
      const w60 = win(rows.map(r => r.excess[60]).filter((x): x is number => x != null));
      console.log(`${t.padEnd(22)}${String(rows.length).padStart(6)}${cols.map(fmt).join('')}${w60.toFixed(0).padStart(8)}%`);
    }
  }
  console.log('\n判讀：某型態 train/test D20/D60 淨超額皆正 → 生產化 N_weeklyX；全負/不一致 → 研究區關帳。');
}
main().catch(e => { console.error(e); process.exit(1); });
