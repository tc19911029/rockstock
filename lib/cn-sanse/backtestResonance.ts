// ============================================================
// 三色資金 — 共振組合回測：把每個歷史掃描日的 records 依「策略×指標買點」分桶，
// 對齊未來漲跌幅（隔日開進場 → 1/3/5/10/20日/最高/最低），算各桶平均報酬 + 勝率 + 樣本數。
// 用來回答：到底哪一種共振組合最容易上漲。
//
// 桶定義 / 報酬量測單一事實來源：rankingScore.ts（bucketsForRecord）+ forwardMetrics.ts。
// 本檔是「即時 30 天」版本（讀固化掃描快照，受 scanStorage KEEP_DAYS=30 限制）；
// 全期深度版見 scripts/backtest-cn-sanse-rerank.ts，會固化更完整的 data/cn-sanse/bucket-stats.json。
// ============================================================

import { listSanSeDates, loadSanSeScan } from './scanStorage';
import { analyzeForwardBatch } from '@/lib/backtest/ForwardAnalyzer';
import { metricsFromOpen } from './forwardMetrics';
import {
  BT_HORIZONS, WINRATE_KEYS, BUCKET_DEFS, bucketsForRecord,
  type HKey, type BucketStat, type RankRecord,
} from './rankingScore';

export { BT_HORIZONS };
export type { BucketStat, HKey };

export interface ResonanceBacktest {
  buckets: BucketStat[];
  days: number;
  samples: number;     // 累計有效 record 數（至少一個 horizon 有報酬）
  computedAt: string;
}

interface Acc { sum: Record<HKey, number>; cnt: Record<HKey, number>; win: Record<HKey, number> }
const emptyAcc = (): Acc => {
  const z = () => Object.fromEntries(BT_HORIZONS.map((h) => [h.key, 0])) as Record<HKey, number>;
  return { sum: z(), cnt: z(), win: z() };
};

/** 由 (record, 隔日開報酬) 列表累計成桶統計。深度回測與即時回測共用，保證桶定義一致。 */
export function buildBucketStats(
  rows: Array<{ record: RankRecord; metrics: Record<HKey, number | null> }>,
): { buckets: BucketStat[]; samples: number } {
  const acc = new Map<string, Acc>();
  for (const def of BUCKET_DEFS) acc.set(def.key, emptyAcc());

  let samples = 0;
  for (const { record, metrics } of rows) {
    let counted = false;
    const keys = bucketsForRecord(record);
    for (const key of keys) {
      const a = acc.get(key);
      if (!a) continue;
      for (const h of BT_HORIZONS) {
        const v = metrics[h.key];
        if (v == null || !Number.isFinite(v)) continue;
        a.sum[h.key] += v;
        a.cnt[h.key] += 1;
        if (WINRATE_KEYS.has(h.key) && v > 0) a.win[h.key] += 1;
        counted = true;
      }
    }
    if (counted) samples++;
  }

  const buckets: BucketStat[] = BUCKET_DEFS.map((def) => {
    const a = acc.get(def.key)!;
    const avg = {} as Record<HKey, number | null>;
    const win = {} as Record<HKey, number | null>;
    const cnt = {} as Record<HKey, number>;
    let n = 0;
    for (const h of BT_HORIZONS) {
      const c = a.cnt[h.key];
      cnt[h.key] = c;
      n = Math.max(n, c);
      avg[h.key] = c ? +(a.sum[h.key] / c).toFixed(2) : null;
      win[h.key] = c && WINRATE_KEYS.has(h.key) ? +((a.win[h.key] / c) * 100).toFixed(0) : null;
    }
    return { key: def.key, label: def.label, group: def.group, n, cnt, avg, win };
  });

  return { buckets, samples };
}

export async function runResonanceBacktest(): Promise<ResonanceBacktest> {
  const dates = await listSanSeDates();
  const rows: Array<{ record: RankRecord; metrics: Record<HKey, number | null> }> = [];
  let days = 0;

  for (const d of dates) {
    const session = await loadSanSeScan(d.date);
    // 每日取共振數最高的前 N 檔做 forward（≥1組選股後一天 ~800 檔，全算 30 天會逾時）；
    // records 已按 groupBuyCount→短攻 排序，取前段即涵蓋各強度桶的主要樣本。
    const records = (session?.records ?? []).slice(0, 150);
    if (!records.length) continue;
    days++;

    const { results } = await analyzeForwardBatch(
      records.map((r) => ({ symbol: r.symbol, name: r.name, scanPrice: r.price })),
      d.date,
    );
    const perfMap = new Map(results.map((p) => [p.symbol, p]));
    for (const r of records) {
      const perf = perfMap.get(r.symbol);
      if (!perf) continue;
      rows.push({ record: r, metrics: metricsFromOpen(perf) });
    }
  }

  const { buckets, samples } = buildBucketStats(rows);
  return { buckets, days, samples, computedAt: new Date().toISOString() };
}
