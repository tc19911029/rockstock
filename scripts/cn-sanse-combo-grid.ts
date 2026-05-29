// ============================================================
// 三色資金 — 細條件「混搭」網格分析（讀 bt-samples.jsonl，離線、秒級）
//
// 把策略池每筆拆成 (主力階段 × 雙B型 × 捕撈型) 的交集格，算各格 forward 報酬/勝率，
// 並用「前段訓練 / 後段測試」切兩半：只在訓練段挑出來的好組合，拿到沒看過的測試段
// 還賺不賺？避免「試了幾十種挑最高 = 過度擬合」的陷阱。
//
// 用法：npx tsx scripts/cn-sanse-combo-grid.ts [最小樣本=60] [訓練佔比=0.6] [排序horizon=d5]
//   需先有 data/cn-sanse/bt-samples.jsonl（由 backtest-cn-sanse-rerank.ts 產出）
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';

interface Sample {
  date: string; pool: boolean; stage: string; b: string; c: string;
  up: boolean; conflict: boolean; lvl: string; gbc: number;
  d3: number | null; d5: number | null; d10: number | null; mg: number | null; ml: number | null;
}
type HK = 'd3' | 'd5' | 'd10';

const STAGE_L: Record<string, string> = { full: '滿分⭐', develop: '發展📈', ignite: '點火🔥', observe: '觀察' };
const B_L: Record<string, string> = { none: '雙B無', gold: '雙B金叉', break: '雙B突破', reson: '雙B共振' };
const C_L: Record<string, string> = { none: '捕撈無', bull: '捕撈多頭', bear: '捕撈空頭底反' };

function stat(rows: Sample[], h: HK) {
  const v = rows.map((r) => r[h]).filter((x): x is number => x != null && Number.isFinite(x));
  if (!v.length) return { n: 0, avg: null as number | null, win: null as number | null };
  return {
    n: v.length,
    avg: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2),
    win: Math.round((v.filter((x) => x > 0).length / v.length) * 100),
  };
}
const fp = (v: number | null) => (v == null ? '  — ' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`);

async function main() {
  const minN = parseInt(process.argv[2] ?? '60', 10) || 60;
  const split = parseFloat(process.argv[3] ?? '0.6') || 0.6;
  const hz = (process.argv[4] ?? 'd5') as HK;
  const outDir = path.join(process.cwd(), 'data', 'cn-sanse');

  const raw = await fs.readFile(path.join(outDir, 'bt-samples.jsonl'), 'utf8');
  const all: Sample[] = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pool = all.filter((s) => s.pool && s.stage !== 'observe');

  // 前段訓練 / 後段測試（依日期切）
  const dates = [...new Set(pool.map((s) => s.date))].sort();
  const cut = dates[Math.floor(dates.length * split)];
  const train = pool.filter((s) => s.date < cut);
  const test = pool.filter((s) => s.date >= cut);

  // 建交集格 stage×b×c
  const keyOf = (s: Sample) => `${s.stage}|${s.b}|${s.c}`;
  const labelOf = (k: string) => { const [s, b, c] = k.split('|'); return `${STAGE_L[s]}·${B_L[b]}·${C_L[c]}`; };
  const group = (rows: Sample[]) => {
    const m = new Map<string, Sample[]>();
    for (const s of rows) { const k = keyOf(s); (m.get(k) ?? m.set(k, []).get(k)!).push(s); }
    return m;
  };
  const gTrain = group(train);
  const gTest = group(test);
  const gAll = group(pool);

  const L: string[] = [];
  L.push('# 三色資金 — 細條件混搭網格（主力階段 × 雙B型 × 捕撈型）');
  L.push('');
  L.push(`池內樣本 ${pool.length} 筆｜訓練 ${train.length}（${dates[0]}~${cut}）｜測試 ${test.length}（${cut}~${dates[dates.length - 1]}）｜進場隔日開盤｜最小樣本 ${minN}`);
  L.push('');

  // 全期排名（依 hz 平均），只列 n≥minN
  const allKeys = [...gAll.keys()].filter((k) => stat(gAll.get(k)!, hz).n >= minN);
  const rankedAll = allKeys.map((k) => ({ k, ...stat(gAll.get(k)!, hz) }))
    .sort((a, b) => (b.avg ?? -999) - (a.avg ?? -999));

  const base = stat(pool, hz);
  L.push(`## 全期排名（依 ${hz} 平均；池基準 ${fp(base.avg)}% / 勝率 ${base.win}%）`);
  L.push('');
  L.push(`| # | 組合 | 樣本 | 3日 | 5日 | 10日 | 勝率(${hz}) | 平均最低 |`);
  L.push('|--:|---|--:|--:|--:|--:|--:|--:|');
  rankedAll.forEach((r, i) => {
    const rows = gAll.get(r.k)!;
    const s3 = stat(rows, 'd3'), s5 = stat(rows, 'd5'), s10 = stat(rows, 'd10');
    const ml = rows.map((x) => x.ml).filter((x): x is number => x != null);
    const mlAvg = ml.length ? +(ml.reduce((a, b) => a + b, 0) / ml.length).toFixed(1) : null;
    L.push(`| ${i + 1} | ${labelOf(r.k)} | ${r.n} | ${fp(s3.avg)} | ${fp(s5.avg)} | ${fp(s10.avg)} | ${r.win}% | ${fp(mlAvg)} |`);
  });
  L.push('');

  // 過度擬合檢查：訓練 vs 測試（只看訓練段排前面的，看測試段還守不守得住）
  L.push(`## 過度擬合檢查 — 訓練段挑出的好組合，測試段還賺嗎？（依訓練 ${hz} 平均排序）`);
  L.push('');
  L.push(`| 組合 | 訓練樣本 | 訓練${hz} | 訓練勝率 | 測試樣本 | 測試${hz} | 測試勝率 | 守得住? |`);
  L.push('|---|--:|--:|--:|--:|--:|--:|:--:|');
  const trainKeys = [...gTrain.keys()].filter((k) => stat(gTrain.get(k)!, hz).n >= minN);
  const rankedTrain = trainKeys.map((k) => ({ k, tr: stat(gTrain.get(k)!, hz) }))
    .sort((a, b) => (b.tr.avg ?? -999) - (a.tr.avg ?? -999)).slice(0, 12);
  for (const { k, tr } of rankedTrain) {
    const te = gTest.has(k) ? stat(gTest.get(k)!, hz) : { n: 0, avg: null, win: null };
    const held = te.n >= 20 && te.avg != null && te.avg > 0 && (tr.avg ?? 0) > 0 ? '✅' : te.n < 20 ? '樣本少' : '❌';
    L.push(`| ${labelOf(k)} | ${tr.n} | ${fp(tr.avg)} | ${tr.win}% | ${te.n} | ${fp(te.avg)} | ${te.win ?? '—'}% | ${held} |`);
  }
  L.push('');
  L.push('> ✅=訓練+測試都正報酬（較可信）；❌=測試段轉負（訓練段是運氣/過度擬合）；樣本少=測試段不足以判定。');
  L.push('> 提醒：勝率 50% 上下、平均 sub-1% 是常態；組合越細樣本越少越不可信。這是產生假設，不是保證賺錢公式。');

  const md = L.join('\n');
  await fs.writeFile(path.join(outDir, 'combo-grid.md'), md, 'utf8');
  console.log(md);
}

main().catch((e) => { console.error(e); process.exit(1); });
