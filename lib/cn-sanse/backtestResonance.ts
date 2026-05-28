// ============================================================
// 三色資金 — 共振組合回測：把每個歷史掃描日的 records 依「策略×指標買點」分桶，
// 對齊未來漲跌幅（隔日/1/3/5/10/20日/最高/最低），算各桶的平均報酬 + 勝率 + 樣本數。
// 用來回答：到底哪一種共振組合最容易上漲。
// ============================================================

import { listSanSeDates, loadSanSeScan } from './scanStorage';
import { analyzeForwardBatch } from '@/lib/backtest/ForwardAnalyzer';
import type { StockForwardPerformance } from '@/lib/scanner/types';
import type { ResonanceRecord } from './scan';

export const BT_HORIZONS = [
  { key: 'openReturn', label: '隔日開' },
  { key: 'd1Return', label: '1日' },
  { key: 'd3Return', label: '3日' },
  { key: 'd5Return', label: '5日' },
  { key: 'd10Return', label: '10日' },
  { key: 'd20Return', label: '20日' },
  { key: 'maxGain', label: '最高' },
  { key: 'maxLoss', label: '最低' },
] as const;
type HKey = (typeof BT_HORIZONS)[number]['key'];
const WINRATE_KEYS = new Set<HKey>(['openReturn', 'd1Return', 'd3Return', 'd5Return', 'd10Return', 'd20Return']);

export interface BucketStat {
  key: string; label: string; group: string; n: number;
  avg: Record<HKey, number | null>;     // 平均報酬 %
  win: Record<HKey, number | null>;     // 勝率 %（僅報酬類有意義）
}

export interface ResonanceBacktest {
  buckets: BucketStat[];
  days: number;
  samples: number;     // 累計 record×日（去 null forward 後的有效筆）
  computedAt: string;
}

// 桶定義（顯示順序）
const STRATS: { k: string; label: string }[] = [
  { k: 'strict', label: '嚴格' }, { k: 'medium', label: '中等' }, { k: 'loose', label: '寬鬆' },
];
const BUCKET_DEFS: { key: string; label: string; group: string }[] = [
  ...STRATS.flatMap((s) => [
    { key: s.k, label: `${s.label} 單獨`, group: s.label },
    { key: `${s.k}+b`, label: `${s.label} +雙B`, group: s.label },
    { key: `${s.k}+c`, label: `${s.label} +捕撈`, group: s.label },
    { key: `${s.k}+bc`, label: `${s.label} +雙指標`, group: s.label },
  ]),
  { key: 'observe+b', label: '觀察 雙B買', group: '觀察區' },
  { key: 'observe+c', label: '觀察 捕撈買', group: '觀察區' },
  { key: 'noconflict', label: '無衝突', group: '衝突' },
  { key: 'conflict', label: '有衝突', group: '衝突' },
];

function bucketsForRecord(r: ResonanceRecord): string[] {
  const keys: string[] = [];
  for (const s of r.strategies) {
    keys.push(s);
    if (r.doubleBBuy) keys.push(`${s}+b`);
    if (r.catchBuy) keys.push(`${s}+c`);
    if (r.doubleBBuy && r.catchBuy) keys.push(`${s}+bc`);
  }
  if (r.strategies.length === 0) {
    if (r.doubleBBuy) keys.push('observe+b');
    if (r.catchBuy) keys.push('observe+c');
  }
  keys.push(r.conflict ? 'conflict' : 'noconflict');
  return keys;
}

interface Acc { sum: Record<HKey, number>; cnt: Record<HKey, number>; win: Record<HKey, number> }
const emptyAcc = (): Acc => {
  const z = () => Object.fromEntries(BT_HORIZONS.map((h) => [h.key, 0])) as Record<HKey, number>;
  return { sum: z(), cnt: z(), win: z() };
};

export async function runResonanceBacktest(): Promise<ResonanceBacktest> {
  const dates = await listSanSeDates();
  const acc = new Map<string, Acc>();
  for (const def of BUCKET_DEFS) acc.set(def.key, emptyAcc());

  let days = 0;
  let samples = 0;

  for (const d of dates) {
    const session = await loadSanSeScan(d.date);
    const records = session?.records ?? [];
    if (!records.length) continue;
    days++;

    const { results } = await analyzeForwardBatch(
      records.map((r) => ({ symbol: r.symbol, name: r.name, scanPrice: r.price })),
      d.date,
    );
    const perfMap = new Map<string, StockForwardPerformance>(results.map((p) => [p.symbol, p]));

    for (const r of records) {
      const perf = perfMap.get(r.symbol);
      if (!perf) continue;
      let counted = false;
      for (const key of bucketsForRecord(r)) {
        const a = acc.get(key);
        if (!a) continue;
        for (const h of BT_HORIZONS) {
          const v = perf[h.key] as number | null | undefined;
          if (v == null || !Number.isFinite(v)) continue;
          a.sum[h.key] += v;
          a.cnt[h.key] += 1;
          if (WINRATE_KEYS.has(h.key) && v > 0) a.win[h.key] += 1;
          counted = true;
        }
      }
      if (counted) samples++;
    }
  }

  const buckets: BucketStat[] = BUCKET_DEFS.map((def) => {
    const a = acc.get(def.key)!;
    const avg = {} as Record<HKey, number | null>;
    const win = {} as Record<HKey, number | null>;
    let n = 0;
    for (const h of BT_HORIZONS) {
      const c = a.cnt[h.key];
      n = Math.max(n, c);
      avg[h.key] = c ? +(a.sum[h.key] / c).toFixed(2) : null;
      win[h.key] = c && WINRATE_KEYS.has(h.key) ? +((a.win[h.key] / c) * 100).toFixed(0) : null;
    }
    return { key: def.key, label: def.label, group: def.group, n, avg, win };
  });

  return { buckets, days, samples, computedAt: new Date().toISOString() };
}
