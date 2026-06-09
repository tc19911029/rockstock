/**
 * 三色資金「參數凍結」合約測試（鐵律 #7）。
 *
 * 把兩件參數化重構最關鍵的不變量釘死：
 *   1. GOLDEN：重構後（抽 dualB + 接 SanSeParams）的指標輸出，必須與重構前逐位元相同。
 *      golden 值由 scripts/_capture-golden.ts 在「重構前」的程式碼上抓下、存於 fixtures/sanse-golden.json。
 *      （既有 tw-sanse-parity 只比「掃描↔走圖」彼此一致，兩路都走新 helper → 抓不到「整體一起漂移」的抽取錯誤；
 *        故必須有一組來自舊碼的 golden 數值當真正的金絲雀。）
 *   2. FROZEN：不帶參數呼叫 == 明確帶 PRODUCTION_PARAMS，保證預設路徑與顯式參數路徑不分岔。
 *
 * 純函式、不碰磁碟（fixture 例外，唯讀）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Candle } from '@/types';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { evalConditions } from '@/lib/cn-sanse/conditions';
import { computeSanSeChart, type DayExtrasArr } from '@/lib/cn-sanse/indicators';
import { PRODUCTION_PARAMS } from '@/lib/cn-sanse/params';

const N = 540;
const MID = 400;

// ⚠️ 必須與 scripts/_capture-golden.ts 的產生器逐字相同，否則 golden 對不上。
function genCandles(n: number): Candle[] {
  const d = new Date('2026-05-29T00:00:00Z');
  const dates: string[] = [];
  for (let i = 0; i < n; i++) { dates.unshift(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  return dates.map((date, i) => {
    const base = 50 + i * 0.08 + 6 * Math.sin(i / 9) + 2 * Math.sin(i / 3);
    return {
      date,
      open: +base.toFixed(4),
      high: +(base * 1.03).toFixed(4),
      low: +(base * 0.97).toFixed(4),
      close: +(base * (1 + 0.01 * Math.cos(i / 4))).toFixed(4),
      volume: Math.round(100000 + (i % 17) * 6000 + 3000 * Math.sin(i / 5)),
    };
  });
}

function genExtras(candles: Candle[]): DayExtrasArr {
  return {
    amount: candles.map((c) => c.close * c.volume * 100),
    vol: candles.map((c) => c.volume),
    turnover: candles.map((_, i) => +(2.5 + 3 * Math.abs(Math.sin(i / 11)) + 1.5 * Math.abs(Math.cos(i / 7))).toFixed(4)),
  };
}

function buildSnapshot() {
  const candles = genCandles(N);
  const index = genCandles(N).map((c) => c.close);
  const extras = genExtras(candles);
  const s = computeSanSe(candles, index);
  const report = evalConditions(candles, index, s);
  const chart = computeSanSeChart(candles, index, extras);
  const lastVal = (arr: { value: number }[]) => (arr.length ? arr[arr.length - 1].value : null);
  const r6 = (x: number) => (Number.isFinite(x) ? +x.toFixed(6) : x);
  return {
    sanse: {
      last: { sa: r6(s.shortAttack[N - 1]), ms: r6(s.midStrength[N - 1]), mc: r6(s.midControl[N - 1]), kp: r6(s.kongPan[N - 1]), so: r6(s.shortOversold[N - 1]) },
      mid: { sa: r6(s.shortAttack[MID]), ms: r6(s.midStrength[MID]), mc: r6(s.midControl[MID]), kp: r6(s.kongPan[MID]), so: r6(s.shortOversold[MID]) },
      counts: { strict: s.strict.filter(Boolean).length, medium: s.medium.filter(Boolean).length, loose: s.loose.filter(Boolean).length },
    },
    report,
    chart: {
      zb4: lastVal(chart.zb4), zb5: lastVal(chart.zb5), zhineng: lastVal(chart.zhineng), duokong: lastVal(chart.duokong),
      xys0: chart.xys0.length ? chart.xys0[chart.xys0.length - 1].value : null,
      xys1: lastVal(chart.xys1), xys2: lastVal(chart.xys2),
      midZb4: chart.zb4.find((p) => p.time === candles[MID].date)?.value ?? null,
      midXys1: chart.xys1.find((p) => p.time === candles[MID].date)?.value ?? null,
      scores: chart.scores,
      tiers: chart.xysTiers ? {
        green: chart.xysTiers.green.length, yellow: chart.xysTiers.yellow.length,
        cyan: chart.xysTiers.cyan.length, blue: chart.xysTiers.blue.length,
      } : null,
    },
  };
}

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/sanse-golden.json'), 'utf8'));

describe('三色 參數化重構 — GOLDEN（重構後輸出 == 重構前逐位元）', () => {
  const snap = buildSnapshot();
  test('computeSanSe 分數 + 選股計數 不變', () => {
    expect(snap.sanse).toEqual(GOLDEN.sanse);
  });
  test('evalConditions 完整報告 不變', () => {
    expect(snap.report).toEqual(GOLDEN.report);
  });
  test('computeSanSeChart 線值 + 4 級彩柱計數 不變', () => {
    expect(snap.chart).toEqual(GOLDEN.chart);
  });
});

describe('三色 參數化重構 — FROZEN（不帶參數 == PRODUCTION_PARAMS）', () => {
  const candles = genCandles(N);
  const index = genCandles(N).map((c) => c.close);
  test('computeSanSe：預設路徑 == 顯式 PRODUCTION_PARAMS', () => {
    expect(computeSanSe(candles, index)).toEqual(computeSanSe(candles, index, NaN, PRODUCTION_PARAMS));
  });
  test('evalConditions（傳 series）：預設路徑 == 顯式 PRODUCTION_PARAMS', () => {
    const s = computeSanSe(candles, index);
    expect(evalConditions(candles, index, s)).toEqual(evalConditions(candles, index, s, 0.10, PRODUCTION_PARAMS));
  });
  test('evalConditions（自行重算 series）：預設路徑 == 顯式 PRODUCTION_PARAMS', () => {
    expect(evalConditions(candles, index)).toEqual(evalConditions(candles, index, undefined, 0.10, PRODUCTION_PARAMS));
  });
});
