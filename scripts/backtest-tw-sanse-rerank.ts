// ============================================================
// 三色資金（台股）— 全期深度回測 + 期望漲幅重排 walk-forward 驗證
//
// lib/cn-sanse 回測的台股 fork：逐個交易日「在記憶體」重算 scanTwSanSe，一次跑完：
//   Phase A 每日 scanTwSanSe + analyzeForwardBatch（隔日開進場報酬，ForwardAnalyzer 依 .TW 後綴自動讀 TW K）
//   Phase B 全期桶統計 → data/tw-sanse/bucket-stats.json + 人類可讀報告
//   Phase C walk-forward：每個決策日只用「outcome 已完成」的樣本建桶（無 lookahead）
//
// ⚠️ 三色是自創因子；此回測僅供探索「三色在台股有沒有 alpha」。是否 promote 成 production
//    台股掃描策略由使用者看完報告決定（不在此腳本自動上線）。
//
// 用法：npx tsx scripts/backtest-tw-sanse-rerank.ts [天數=245] [每日forward上限=300]
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { scanTwSanSe } from '@/lib/tw-sanse/scan';
import type { ResonanceRecord } from '@/lib/cn-sanse/scan';
import { analyzeForwardBatch } from '@/lib/backtest/ForwardAnalyzer';
import { metricsFromOpen } from '@/lib/cn-sanse/forwardMetrics';
import { buildBucketStats } from '@/lib/cn-sanse/backtestResonance';
import {
  BT_HORIZONS, RANK_HORIZONS, BUCKET_DEFS, bucketsForRecord, rerankRecords,
  type HKey, type BucketStat,
} from '@/lib/cn-sanse/rankingScore';
import type { Candle } from '@/types';

const INDEX_SYMBOL = '^TWII';
const WARMUP = 60;
const MIN_TRAIN = 300;
const FORWARD_TD = 32;
const COMPLETE_LAG: Record<string, number> = { d3Return: 3, d5Return: 5, d10Return: 10, maxGain: 30 };

interface DayData {
  date: string;
  records: ResonanceRecord[];
  pool: ResonanceRecord[];
  metrics: Map<string, Record<HKey, number | null>>;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function profileOf(r: ResonanceRecord) {
  const rep = r.report;
  const hasB = rep.doubleB.buyHit;
  const hasC = rep.catch.buyHit;
  let b = 'none';
  if (hasB) {
    const reson = rep.doubleB.buy.some((c) => c.id === 'b_resonance' && c.met);
    const gold = rep.doubleB.buy.some((c) => c.id === 'b_gold' && c.met);
    const brk = rep.doubleB.buy.some((c) => c.id === 'b_break' && c.met);
    b = reson || (gold && brk) ? 'reson' : gold ? 'gold' : brk ? 'break' : 'none';
  }
  let c = 'none';
  if (hasC) {
    c = rep.catch.buy.some((x) => x.id === 'c_gold_bull' && x.met) ? 'bull'
      : rep.catch.buy.some((x) => x.id === 'c_gold_bear' && x.met) ? 'bear' : 'none';
  }
  const cVol = rep.catch.buy.some((x) => x.id === 'c_gold_vol' && x.met);
  const mThree = rep.mainforce.buy.some((x) => x.id === 'm_three' && x.met);
  const bothB = rep.doubleB.buy.some((x) => x.id === 'b_break' && x.met)
    && rep.doubleB.buy.some((x) => x.id === 'b_gold' && x.met);
  return {
    stage: rep.mainStage ?? 'observe', b, c,
    up: r.changePct >= 9.5, conflict: rep.conflict,
    lvl: rep.level ?? 'none', gbc: rep.groupBuyCount,
    above: rep.doubleB.buy.some((x) => x.id === 'b_above' && x.met),
    xabove: rep.catch.buy.some((x) => x.id === 'c_above' && x.met),
    cVol, mThree, bothB,
    allin: bothB && mThree && hasC && cVol,
  };
}

async function main() {
  const days = parseInt(process.argv[2] ?? '245', 10) || 245;
  const topN = parseInt(process.argv[3] ?? '300', 10) || 300;
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = getLocalCandleDir('TW');
  const outDir = path.join(process.cwd(), 'data', 'tw-sanse');
  await fs.mkdir(outDir, { recursive: true });

  const idxRaw = await fs.readFile(path.join(dir, `${INDEX_SYMBOL}.json`), 'utf8');
  const idx = JSON.parse(idxRaw)?.candles as Candle[] | undefined;
  if (!Array.isArray(idx) || idx.length === 0) throw new Error(`找不到 ${INDEX_SYMBOL} 本地 K 線`);
  const allDays = idx.map((c) => c.date);
  const usable = allDays.length > FORWARD_TD ? allDays.slice(0, -FORWARD_TD) : allDays;
  const tradingDays = usable.slice(-days);
  console.log(`[tw-rerank] 窗口 ${tradingDays[0]} ~ ${tradingDays[tradingDays.length - 1]}（${tradingDays.length} 交易日, 每日 forward 上限 ${topN}；已排除最近 ${FORWARD_TD} 交易日確保 forward 完整）`);

  // ── Phase A：逐日 scan + forward ──
  const dayData: DayData[] = [];
  for (const date of tradingDays) {
    const t0 = Date.now();
    try {
      const scan = await scanTwSanSe({ asOfDate: date });
      const records = scan.records ?? [];
      if (!records.length) { console.log(`[tw-rerank] ${date} 無共振紀錄，跳過`); continue; }
      const pool = records.filter((r) => r.report.mainforce.buyHit);
      const wanted = new Map<string, ResonanceRecord>();
      for (const r of [...pool, ...records.slice(0, topN)]) wanted.set(r.symbol, r);
      const forwardSet = [...wanted.values()];
      const { results } = await analyzeForwardBatch(
        forwardSet.map((r) => ({ symbol: r.symbol, name: r.name, scanPrice: r.price })),
        date,
      );
      const metrics = new Map<string, Record<HKey, number | null>>();
      for (const p of results) metrics.set(p.symbol, metricsFromOpen(p));
      dayData.push({ date, records, pool, metrics });
      console.log(`[tw-rerank] ${date} ✓ 紀錄 ${records.length} / 池 ${pool.length} / forward ${forwardSet.length}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      console.error(`[tw-rerank] ${date} ✗ ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!dayData.length) throw new Error('無任何可用掃描日');

  // ── 落地逐筆樣本 → bt-samples.jsonl ──
  {
    const lines: string[] = [];
    for (const d of dayData) for (const r of d.records) {
      const m = d.metrics.get(r.symbol);
      if (!m) continue;
      const p = profileOf(r);
      lines.push(JSON.stringify({
        date: d.date, pool: r.report.mainforce.buyHit, ...p,
        d3: m.d3Return, d5: m.d5Return, d10: m.d10Return, mg: m.maxGain, ml: m.maxLoss,
      }));
    }
    await fs.writeFile(path.join(outDir, 'bt-samples.jsonl'), lines.join('\n'), 'utf8');
    console.log(`[tw-rerank] bt-samples.jsonl 已寫（${lines.length} 筆逐筆樣本）`);
  }

  // ── Phase B：全期桶統計 ──
  const rows: Array<{ record: ResonanceRecord; metrics: Record<HKey, number | null> }> = [];
  for (const d of dayData) for (const r of d.records) {
    const m = d.metrics.get(r.symbol);
    if (m) rows.push({ record: r, metrics: m });
  }
  const { buckets, samples } = buildBucketStats(rows);
  const stats = { buckets, days: dayData.length, samples, computedAt: new Date().toISOString() };
  await fs.writeFile(path.join(outDir, 'bucket-stats.json'), JSON.stringify(stats), 'utf8');
  console.log(`[tw-rerank] bucket-stats.json 已寫（${buckets.length} 桶, ${samples} 樣本）`);

  await fs.writeFile(path.join(outDir, `backtest-report-${stamp}.md`), buildReport(stats, topN), 'utf8');

  // ── Phase C：walk-forward 驗證 ──
  const v: string[] = [];
  v.push(`# 三色資金（台股）— 期望漲幅重排 walk-forward 驗證（${stamp}）`);
  v.push('');
  v.push(`窗口：${dayData[0].date} ~ ${dayData[dayData.length - 1].date}（${dayData.length} 交易日）｜暖身 ${WARMUP} 天｜進場：隔日開盤`);
  v.push('');
  v.push('**讀法**：每個決策日只用「報酬已完成」的歷史樣本建桶（無 lookahead），各取當日「策略池」第一檔。');
  v.push('舊=共振強度排序(groupBuyCount→短攻)；新=期望漲幅排序。比較兩者第一檔的「實際」隔日開報酬。');
  v.push('');
  v.push('| 排序基準 | 買第一檔 | 樣本天數 | 平均3日 | 平均5日 | 平均10日 | 平均窗內最高 | 勝率(基準) | 換股率 |');
  v.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const hz of RANK_HORIZONS) {
    const wf = walkForward(dayData, hz.key);
    const o = summarize(wf.oldPicks);
    const n = summarize(wf.newPicks);
    v.push(`| ${hz.label} | 舊(共振) | ${o.n} | ${fmtPct(o.avg.d3Return)} | ${fmtPct(o.avg.d5Return)} | ${fmtPct(o.avg.d10Return)} | ${fmtPct(o.avg.maxGain)} | ${o.win[hz.key] ?? '—'}% | — |`);
    v.push(`| ${hz.label} | **新(期望)** | ${n.n} | **${fmtPct(n.avg.d3Return)}** | **${fmtPct(n.avg.d5Return)}** | **${fmtPct(n.avg.d10Return)}** | **${fmtPct(n.avg.maxGain)}** | **${n.win[hz.key] ?? '—'}%** | ${(wf.changeRate * 100).toFixed(0)}% |`);
  }
  v.push('');
  v.push('> 換股率 = 新排序第一檔與舊排序第一檔不同的比例。');
  await fs.writeFile(path.join(outDir, `rerank-validation-${stamp}.md`), v.join('\n'), 'utf8');
  console.log(`[tw-rerank] 驗證報告已寫 → data/tw-sanse/rerank-validation-${stamp}.md`);
  console.log('\n' + v.slice(7).join('\n'));
}

function walkForward(dayData: DayData[], hz: HKey) {
  const lag = COMPLETE_LAG[hz] ?? 10;
  const accSum = new Map<string, number>();
  const accCnt = new Map<string, number>();
  const oldPicks: Array<Record<HKey, number | null>> = [];
  const newPicks: Array<Record<HKey, number | null>> = [];
  let changed = 0;
  let decided = 0;

  for (let i = 0; i < dayData.length; i++) {
    const rel = i - lag - 1;
    if (rel >= 0) {
      for (const r of dayData[rel].records) {
        const val = dayData[rel].metrics.get(r.symbol)?.[hz];
        if (val == null || !Number.isFinite(val)) continue;
        for (const key of bucketsForRecord(r)) {
          accSum.set(key, (accSum.get(key) ?? 0) + val);
          accCnt.set(key, (accCnt.get(key) ?? 0) + 1);
        }
      }
    }
    if (i < WARMUP) continue;
    const pool = dayData[i].pool;
    if (!pool.length) continue;
    if ((accCnt.get('ALL') ?? 0) < MIN_TRAIN) continue;

    const synth: BucketStat[] = BUCKET_DEFS.map((def) => {
      const cnt = accCnt.get(def.key) ?? 0;
      const avg = cnt ? accSum.get(def.key)! / cnt : null;
      return {
        key: def.key, label: def.label, group: def.group, n: cnt,
        cnt: { [hz]: cnt } as Record<HKey, number>,
        avg: { [hz]: avg } as Record<HKey, number | null>,
        win: {} as Record<HKey, number | null>,
      };
    });

    const oldTop = pool[0];
    const newTop = rerankRecords(pool, synth, hz)[0];
    decided++;
    if (newTop.symbol !== oldTop.symbol) changed++;
    const om = dayData[i].metrics.get(oldTop.symbol);
    const nm = dayData[i].metrics.get(newTop.symbol);
    if (om) oldPicks.push(om);
    if (nm) newPicks.push(nm);
  }
  return { oldPicks, newPicks, changeRate: decided ? changed / decided : 0 };
}

function summarize(picks: Array<Record<HKey, number | null>>) {
  const avg = {} as Record<HKey, number | null>;
  const win = {} as Record<HKey, number | null>;
  let n = 0;
  for (const h of BT_HORIZONS) {
    const vals = picks.map((p) => p[h.key]).filter((val): val is number => val != null && Number.isFinite(val));
    n = Math.max(n, vals.length);
    avg[h.key] = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
    win[h.key] = vals.length ? +((vals.filter((val) => val > 0).length / vals.length) * 100).toFixed(0) : null;
  }
  return { n, avg, win };
}

function buildReport(stats: { buckets: BucketStat[]; days: number; samples: number }, topN: number): string {
  const L: string[] = [];
  L.push(`# 三色資金（台股）— 條件漲幅回測報告`);
  L.push('');
  L.push(`掃描日 ${stats.days} 天｜有效樣本 ${stats.samples} 筆｜進場：隔日開盤`);
  L.push(`每日 forward 上限 ${topN} 檔（共振前段；觀察區/弱共振桶可能受此上限低估，已標 n）`);
  L.push(`maxGain=forward 窗（~45 曆日）內最高；勝率僅報酬類有意義。`);
  L.push('');
  L.push(`> ⚠️ 三色是自創因子。台股選股正式路徑仍以書本規則為準（鐵則 #5）；此報告供評估三色在台股是否有 alpha。`);
  L.push('');

  const byKey = new Map(stats.buckets.map((b) => [b.key, b]));
  for (const hz of RANK_HORIZONS) {
    L.push(`## 漲幅最多的條件 — 依「${hz.label}」排序 Top 10`);
    L.push('');
    L.push(`| 條件桶 | 樣本 | 平均${hz.label} | 勝率 |`);
    L.push('|---|---:|---:|---:|');
    const ranked = stats.buckets
      .filter((b) => b.key !== 'ALL' && (b.avg[hz.key] != null) && b.cnt[hz.key] >= 8)
      .sort((a, b) => (b.avg[hz.key] ?? -999) - (a.avg[hz.key] ?? -999))
      .slice(0, 10);
    for (const b of ranked) {
      L.push(`| ${b.label} | ${b.cnt[hz.key]} | ${fmtPct(b.avg[hz.key])} | ${b.win[hz.key] ?? '—'}% |`);
    }
    const all = byKey.get('ALL');
    if (all) L.push(`| _全體基準_ | ${all.cnt[hz.key]} | ${fmtPct(all.avg[hz.key])} | ${all.win[hz.key] ?? '—'}% |`);
    L.push('');
  }

  L.push('## 完整桶表（所有 horizon）');
  L.push('');
  L.push(`| 條件桶 | 樣本 | ${BT_HORIZONS.map((h) => h.label).join(' | ')} |`);
  L.push(`|---|---:|${BT_HORIZONS.map(() => '---:').join('|')}|`);
  let lastGroup = '';
  for (const b of stats.buckets) {
    if (b.group !== lastGroup) { L.push(`| **${b.group}** | | ${BT_HORIZONS.map(() => '').join(' | ')} |`); lastGroup = b.group; }
    L.push(`| ${b.label} | ${b.n} | ${BT_HORIZONS.map((h) => fmtPct(b.avg[h.key])).join(' | ')} |`);
  }
  return L.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
