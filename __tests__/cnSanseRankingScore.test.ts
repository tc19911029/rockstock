/**
 * 三色資金 — 期望漲幅排序（rankingScore）單元測試
 *
 * 保證：桶歸屬正確、shrinkage 行為（小樣本拉回全體均）、
 * 重排只改順序不改集合、且確實把高期望漲幅條件排前面。
 */
import {
  bucketsForRecord, primaryBucketKey, expectedGainScore, rerankRecords,
  BT_HORIZONS, type BucketStat, type RankRecord,
} from '../lib/cn-sanse/rankingScore';
import type { Cond, GroupReport, ConditionReport, MainStage, ResLevel } from '../lib/cn-sanse/conditions';

const sig = (id: string, met: boolean): Cond => ({ id, label: id, met, kind: 'signal' });
const st = (id: string, met: boolean): Cond => ({ id, label: id, met, kind: 'state' });
const grp = (buy: Cond[], sell: Cond[] = []): GroupReport => ({
  buy, sell,
  buyHit: buy.some((c) => c.kind === 'signal' && c.met),
  sellHit: sell.some((c) => c.kind === 'signal' && c.met),
});

interface Opts {
  stage?: MainStage | null;
  b?: 'reson' | 'gold' | 'break' | null;
  c?: 'bull' | 'bear' | null;
  conflict?: boolean;
}
function mkRecord(opts: Opts, changePct = 3): RankRecord {
  const b = opts.b ?? null;
  const c = opts.c ?? null;
  const doubleB = grp([
    sig('b_gold', b === 'gold' || b === 'reson'),
    sig('b_break', b === 'break' || b === 'reson'),
    sig('b_resonance', b === 'reson'),
  ]);
  const catchG = grp([
    sig('c_gold', c != null),
    st('c_gold_bull', c === 'bull'),
    st('c_gold_bear', c === 'bear'),
  ]);
  const mainforce = grp([sig('m_stage', opts.stage != null)]);
  const buyHits = [doubleB.buyHit, mainforce.buyHit, catchG.buyHit].filter(Boolean).length;
  const level: ResLevel | null = buyHits >= 3 ? 'strong' : buyHits === 2 ? 'medium' : buyHits === 1 ? 'weak' : null;
  const report: ConditionReport = {
    doubleB, mainforce, catch: catchG,
    mainStage: opts.stage ?? null,
    groupBuyCount: buyHits,
    level,
    selected: buyHits >= 1,
    conflict: !!opts.conflict,
    sellWarnings: [],
    scores: { shortAttack: 1, midStrength: 1, midControl: 1, kongPan: 1 },
  };
  return { changePct, report };
}

// 建桶統計：只填 d3Return 即可（測試以該 horizon 排序）
function bucket(key: string, n: number, d3: number | null): BucketStat {
  const z = () => Object.fromEntries(BT_HORIZONS.map((h) => [h.key, 0])) as Record<string, number>;
  const avg = Object.fromEntries(BT_HORIZONS.map((h) => [h.key, null])) as Record<string, number | null>;
  const cnt = z();
  avg.d3Return = d3;
  cnt.d3Return = n;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { key, label: key, group: '', n, cnt: cnt as any, avg: avg as any, win: {} as any };
}

describe('bucketsForRecord', () => {
  it('主力發展 + 雙B共振 + 多頭捕撈 + 漲停 → 落入對應全部桶', () => {
    const r = mkRecord({ stage: 'develop', b: 'reson', c: 'bull' }, 10);
    const keys = bucketsForRecord(r);
    expect(keys).toEqual(expect.arrayContaining([
      'ALL', 'develop', 'develop+b', 'develop+c', 'develop+bc',
      'lvl_strong', 'b_reson', 'c_bull', 'limitup', 'noconflict',
    ]));
    expect(keys).not.toContain('b_goldonly');
    expect(keys).not.toContain('notlimitup');
  });

  it('純突破、空頭捕撈、未漲停、衝突 → 對應描述桶', () => {
    const r = mkRecord({ stage: 'ignite', b: 'break', c: 'bear', conflict: true }, 2);
    const keys = bucketsForRecord(r);
    expect(keys).toEqual(expect.arrayContaining(['b_breakonly', 'c_bear', 'notlimitup', 'conflict', 'ignite+bc']));
    expect(keys).not.toContain('b_reson');
  });

  it('無主力階段（觀察區）→ observe 桶而非 stage 桶', () => {
    const r = mkRecord({ stage: null, b: 'gold' });
    expect(bucketsForRecord(r)).toEqual(expect.arrayContaining(['observe+b']));
    expect(primaryBucketKey(r)).toBe('observe+b');
  });
});

describe('primaryBucketKey', () => {
  it('取最具體的 stage×指標桶', () => {
    expect(primaryBucketKey(mkRecord({ stage: 'full', b: 'gold', c: 'bull' }))).toBe('full+bc');
    expect(primaryBucketKey(mkRecord({ stage: 'full', b: 'gold' }))).toBe('full+b');
    expect(primaryBucketKey(mkRecord({ stage: 'develop' }))).toBe('develop');
  });
});

describe('expectedGainScore — shrinkage', () => {
  const buckets = [
    bucket('ALL', 1000, 1.0),     // 全體均 +1%
    bucket('develop+b', 2, 30.0), // 高均但只有 2 樣本 → 應被拉回接近全體
    bucket('full+bc', 500, 8.0),  // 高均且大樣本 → 應接近桶均
  ];
  it('小樣本桶被拉回全體均值附近', () => {
    const r = mkRecord({ stage: 'develop', b: 'gold' }); // primary = develop+b
    const s = expectedGainScore(r, buckets, 'd3Return', { shrinkK: 20 });
    // (2*30 + 20*1)/(2+20) = 80/22 ≈ 3.64，遠離 30、靠近全體
    expect(s).toBeCloseTo(80 / 22, 2);
    expect(s).toBeLessThan(5);
  });
  it('大樣本桶逼近桶均值', () => {
    const r = mkRecord({ stage: 'full', b: 'gold', c: 'bull' }); // primary = full+bc
    const s = expectedGainScore(r, buckets, 'd3Return', { shrinkK: 20 });
    // (500*8 + 20*1)/520 ≈ 7.73
    expect(s).toBeCloseTo((500 * 8 + 20 * 1) / 520, 2);
    expect(s).toBeGreaterThan(7);
  });
  it('找不到桶 → 退回全體均值', () => {
    const r = mkRecord({ stage: 'ignite' }); // primary=ignite，buckets 無此桶
    expect(expectedGainScore(r, buckets, 'd3Return')).toBe(1.0);
  });
});

describe('rerankRecords', () => {
  const buckets = [
    bucket('ALL', 1000, 1.0),
    bucket('full+bc', 500, 2.0),   // 共振最強但歷史漲幅普通
    bucket('develop+b', 500, 12.0), // 共振中等但歷史最會漲
    bucket('ignite', 500, 5.0),
  ];
  const records: Array<RankRecord & { symbol: string }> = [
    { symbol: 'A', ...mkRecord({ stage: 'full', b: 'gold', c: 'bull' }) },   // full+bc，groupBuyCount=3
    { symbol: 'B', ...mkRecord({ stage: 'develop', b: 'gold' }) },           // develop+b，groupBuyCount=2
    { symbol: 'C', ...mkRecord({ stage: 'ignite' }) },                        // ignite，groupBuyCount=1
  ];

  it('把期望漲幅最高的條件排第一（B 的 develop+b 漲幅最高 → 越過共振最強的 A）', () => {
    const out = rerankRecords(records, buckets, 'd3Return');
    expect(out[0].symbol).toBe('B');
  });

  it('只改順序、不改集合（同一組 symbol、長度不變）', () => {
    const out = rerankRecords(records, buckets, 'd3Return');
    expect(out).toHaveLength(records.length);
    expect(out.map((r) => r.symbol).sort()).toEqual(['A', 'B', 'C']);
  });

  it('回傳新陣列，不就地改動輸入順序', () => {
    const before = records.map((r) => r.symbol);
    rerankRecords(records, buckets, 'd3Return');
    expect(records.map((r) => r.symbol)).toEqual(before);
  });
});
