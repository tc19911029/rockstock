// ============================================================
// 三色資金 — 細條件「混搭」網格分析 + 大盤 regime 閘門（讀 bt-samples.jsonl，離線秒級）
//
// (1) 先量「大盤閘門」本身的價值：上證指數多頭/盤整/空頭日，池子第一手報酬差多少。
// (2) 再在「指定 regime（預設多頭）」內做 主力階段×雙B型×捕撈型 交集網格，
//     並切前段訓練/後段測試，看組合在對的 regime 裡是否比較守得住（避免過度擬合自欺）。
//
// regime 依上證指數(000001.SS) 當日收盤 vs MA20/MA60（as-of，無 lookahead）：
//   多頭=收>MA20且收>MA60；空頭=收<MA20且收<MA60；其餘=盤整。
//
// 用法：npx tsx scripts/cn-sanse-combo-grid.ts [最小樣本=40] [訓練佔比=0.6] [horizon=d5] [regime=bull|all|chop|bear]
//   需先有 data/cn-sanse/bt-samples.jsonl（由 backtest-cn-sanse-rerank.ts 產出）
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';

interface Sample {
  date: string; pool: boolean; stage: string; b: string; c: string;
  up: boolean; conflict: boolean; lvl: string; gbc: number;
  cVol?: boolean; mThree?: boolean; bothB?: boolean; allin?: boolean; // 量柱 / 三色齊 / 突破+金叉 / 全都有
  d3: number | null; d5: number | null; d10: number | null; mg: number | null; ml: number | null;
}
type HK = 'd3' | 'd5' | 'd10';
type Regime = 'bull' | 'chop' | 'bear';

const STAGE_L: Record<string, string> = { full: '滿分⭐', develop: '發展📈', ignite: '點火🔥', observe: '觀察' };
const B_L: Record<string, string> = { none: '雙B無', gold: '雙B金叉', break: '雙B突破', reson: '雙B共振' };
const C_L: Record<string, string> = { none: '捕撈無', bull: '捕撈多頭', bear: '捕撈空頭底反' };
const REG_L: Record<Regime, string> = { bull: '多頭', chop: '盤整', bear: '空頭' };

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

/** 上證指數每日 regime（as-of：收盤與 MA 都只用到當日為止）。 */
async function loadIndexRegime(): Promise<Map<string, Regime>> {
  const raw = await fs.readFile(path.join(process.cwd(), 'data', 'candles', 'CN', '000001.SS.json'), 'utf8');
  const candles = (JSON.parse(raw).candles ?? []) as Array<{ date: string; close: number }>;
  const close = candles.map((c) => c.close);
  const ma = (n: number, i: number) => (i + 1 < n ? null : close.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
  const m = new Map<string, Regime>();
  for (let i = 0; i < candles.length; i++) {
    const c = close[i], m20 = ma(20, i), m60 = ma(60, i);
    let r: Regime = 'chop';
    if (m20 != null && m60 != null) {
      if (c > m20 && c > m60) r = 'bull';
      else if (c < m20 && c < m60) r = 'bear';
    }
    m.set(candles[i].date, r);
  }
  return m;
}

async function main() {
  const minN = parseInt(process.argv[2] ?? '40', 10) || 40;
  const split = parseFloat(process.argv[3] ?? '0.6') || 0.6;
  const hz = (process.argv[4] ?? 'd5') as HK;
  const regimeSel = (process.argv[5] ?? 'bull') as Regime | 'all';
  const outDir = path.join(process.cwd(), 'data', 'cn-sanse');

  const raw = await fs.readFile(path.join(outDir, 'bt-samples.jsonl'), 'utf8');
  const all: Sample[] = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const regimeOf = await loadIndexRegime();
  const poolAll = all.filter((s) => s.pool && s.stage !== 'observe');

  const L: string[] = [];
  L.push('# 三色資金 — 大盤 regime 閘門 + 細條件混搭網格');
  L.push('');

  // ── (1) 大盤閘門本身的價值：各 regime 池子報酬 ───────────────────────────────
  L.push('## (1) 只看大盤：上證多頭 / 盤整 / 空頭日，池子第一手報酬差多少');
  L.push('');
  L.push('| 大盤 regime | 樣本 | 3日 | 勝率 | 5日 | 勝率 | 10日 | 勝率 |');
  L.push('|---|--:|--:|--:|--:|--:|--:|--:|');
  for (const reg of ['bull', 'chop', 'bear'] as Regime[]) {
    const rows = poolAll.filter((s) => regimeOf.get(s.date) === reg);
    const s3 = stat(rows, 'd3'), s5 = stat(rows, 'd5'), s10 = stat(rows, 'd10');
    L.push(`| ${REG_L[reg]} | ${s3.n} | ${fp(s3.avg)} | ${s3.win ?? '—'}% | ${fp(s5.avg)} | ${s5.win ?? '—'}% | ${fp(s10.avg)} | ${s10.win ?? '—'}% |`);
  }
  const baseAllRows = poolAll;
  const bA3 = stat(baseAllRows, 'd3'), bA5 = stat(baseAllRows, 'd5'), bA10 = stat(baseAllRows, 'd10');
  L.push(`| _全部(不擇時)_ | ${bA3.n} | ${fp(bA3.avg)} | ${bA3.win}% | ${fp(bA5.avg)} | ${bA5.win}% | ${fp(bA10.avg)} | ${bA10.win}% |`);
  L.push('');

  // ── (1b) 「全都有」超級組合：雙B突破+金叉 · 三色齊 · 捕撈金叉 · 量柱 ──────────────
  const allinRows = poolAll.filter((s) => s.allin);
  L.push('## (1b) 「全都有」超級組合（雙B突破+金叉 · 三色齊紅紫黃 · 捕撈金叉 · 量柱）');
  L.push('');
  if (allinRows.length === 0) {
    L.push('⚠️ 全期 0 筆完全符合 — 條件太嚴，幾乎不同時出現（這本身就是答案：別等「全都有」）。');
  } else {
    const a3 = stat(allinRows, 'd3'), a5 = stat(allinRows, 'd5'), a10 = stat(allinRows, 'd10');
    const mg = allinRows.map((r) => r.mg).filter((x): x is number => x != null);
    const mgAvg = mg.length ? +(mg.reduce((a, b) => a + b, 0) / mg.length).toFixed(2) : null;
    L.push(`全期 **${allinRows.length} 筆**（佔池 ${(allinRows.length / poolAll.length * 100).toFixed(1)}%）｜3日 ${fp(a3.avg)}%(勝${a3.win}%)｜5日 ${fp(a5.avg)}%(勝${a5.win}%)｜10日 ${fp(a10.avg)}%(勝${a10.win}%)｜窗內最高 ${fp(mgAvg)}%`);
    L.push('');
    L.push('| 切片 | 樣本 | 3日 | 勝率 | 5日 | 勝率 | 10日 | 勝率 |');
    L.push('|---|--:|--:|--:|--:|--:|--:|--:|');
    for (const reg of ['bull', 'chop', 'bear'] as Regime[]) {
      const rows = allinRows.filter((s) => regimeOf.get(s.date) === reg);
      if (!rows.length) { L.push(`| 大盤${REG_L[reg]} | 0 | — | — | — | — | — | — |`); continue; }
      const s3 = stat(rows, 'd3'), s5 = stat(rows, 'd5'), s10 = stat(rows, 'd10');
      L.push(`| 大盤${REG_L[reg]} | ${s3.n} | ${fp(s3.avg)} | ${s3.win ?? '—'}% | ${fp(s5.avg)} | ${s5.win ?? '—'}% | ${fp(s10.avg)} | ${s10.win ?? '—'}% |`);
    }
    // 訓練/測試（全日，allin 太少不再分 regime）
    const ad = [...new Set(allinRows.map((s) => s.date))].sort();
    const acut = ad[Math.floor(ad.length * split)];
    const tr = allinRows.filter((s) => s.date < acut), te = allinRows.filter((s) => s.date >= acut);
    const t5 = stat(tr, 'd5'), e5 = stat(te, 'd5');
    L.push(`| _訓練段_ | ${t5.n} | ${fp(stat(tr, 'd3').avg)} | ${stat(tr, 'd3').win ?? '—'}% | ${fp(t5.avg)} | ${t5.win ?? '—'}% | ${fp(stat(tr, 'd10').avg)} | ${stat(tr, 'd10').win ?? '—'}% |`);
    L.push(`| _測試段_ | ${e5.n} | ${fp(stat(te, 'd3').avg)} | ${stat(te, 'd3').win ?? '—'}% | ${fp(e5.avg)} | ${e5.win ?? '—'}% | ${fp(stat(te, 'd10').avg)} | ${stat(te, 'd10').win ?? '—'}% |`);
    L.push('');
    L.push('> 樣本少(全都有很罕見)→ 數字僅供參考、勿過度解讀。對照池基準看它有沒有明顯加分。');
  }
  L.push('');

  // ── (2) 指定 regime 內的組合網格 + 訓練/測試 ─────────────────────────────────
  const pool = regimeSel === 'all' ? poolAll : poolAll.filter((s) => regimeOf.get(s.date) === regimeSel);
  const regName = regimeSel === 'all' ? '全部日' : `${REG_L[regimeSel as Regime]}日`;
  const dates = [...new Set(pool.map((s) => s.date))].sort();
  const cut = dates[Math.floor(dates.length * split)];
  const train = pool.filter((s) => s.date < cut);
  const test = pool.filter((s) => s.date >= cut);

  const keyOf = (s: Sample) => `${s.stage}|${s.b}|${s.c}`;
  const labelOf = (k: string) => { const [s, b, c] = k.split('|'); return `${STAGE_L[s]}·${B_L[b]}·${C_L[c]}`; };
  const group = (rows: Sample[]) => {
    const m = new Map<string, Sample[]>();
    for (const s of rows) { const k = keyOf(s); if (!m.has(k)) m.set(k, []); m.get(k)!.push(s); }
    return m;
  };
  const gAll = group(pool), gTrain = group(train), gTest = group(test);
  const base = stat(pool, hz);

  L.push(`## (2) ${regName}內 組合網格（主力階段×雙B型×捕撈型）`);
  L.push('');
  L.push(`${regName}池內 ${pool.length} 筆｜訓練 ${train.length}（${dates[0]}~${cut}）｜測試 ${test.length}（${cut}~${dates[dates.length - 1]}）｜最小樣本 ${minN}｜基準 ${hz} ${fp(base.avg)}% / 勝率 ${base.win}%`);
  L.push('');
  const allKeys = [...gAll.keys()].filter((k) => stat(gAll.get(k)!, hz).n >= minN);
  const rankedAll = allKeys.map((k) => ({ k, ...stat(gAll.get(k)!, hz) })).sort((a, b) => (b.avg ?? -999) - (a.avg ?? -999));
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

  L.push(`## (3) ${regName}內 過度擬合檢查 — 訓練段挑出的好組合，測試段還賺嗎？`);
  L.push('');
  L.push(`| 組合 | 訓練樣本 | 訓練${hz} | 訓練勝率 | 測試樣本 | 測試${hz} | 測試勝率 | 守得住? |`);
  L.push('|---|--:|--:|--:|--:|--:|--:|:--:|');
  const trainKeys = [...gTrain.keys()].filter((k) => stat(gTrain.get(k)!, hz).n >= minN);
  const rankedTrain = trainKeys.map((k) => ({ k, tr: stat(gTrain.get(k)!, hz) })).sort((a, b) => (b.tr.avg ?? -999) - (a.tr.avg ?? -999)).slice(0, 12);
  for (const { k, tr } of rankedTrain) {
    const te = gTest.has(k) ? stat(gTest.get(k)!, hz) : { n: 0, avg: null, win: null };
    const held = te.n >= 15 && te.avg != null && te.avg > 0 && (tr.avg ?? 0) > 0 ? '✅' : te.n < 15 ? '樣本少' : '❌';
    L.push(`| ${labelOf(k)} | ${tr.n} | ${fp(tr.avg)} | ${tr.win}% | ${te.n} | ${fp(te.avg)} | ${te.win ?? '—'}% | ${held} |`);
  }
  L.push('');
  L.push('> ✅=訓練+測試都正報酬（較可信）；❌=測試段轉負（過度擬合）；樣本少=測試段不足判定。');
  L.push('> regime 依上證收盤 vs MA20/MA60（as-of 無 lookahead）。勝率 ~50%、平均 sub-1% 仍是常態。');

  const md = L.join('\n');
  await fs.writeFile(path.join(outDir, `combo-grid-${regimeSel}.md`), md, 'utf8');
  console.log(md);
}

main().catch((e) => { console.error(e); process.exit(1); });
