/**
 * 研究：phase×mode 超額報酬的「符號跨期穩定性」（P5 校準前的誠實 gate）
 *
 * 直接拿全樣本交叉表調權重 = in-sample overfit。這支把 492 天切 train(舊60%)/test(新40%)，
 * 比對每個 (mode, phase) 的 d5 超額(vs上證)在兩段的符號是否一致：
 *   - 同號且兩段 n≥STABLE_MIN_N → 穩定，可進權重調整表
 *   - 異號 / 樣本不足 → 不可信（regime 依賴），不調
 * 輸出建議的 sign-based 調整表（magnitude 固定、不擬合幅度，降 overfit）。
 *
 * 用法：npx tsx scripts/research-cn-phase-mode-edge.ts
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { loadEventsWithReturns, type CnRecoEventWithReturns } from '@/lib/cn-agents/backtest/recoPipeline';
import { STAGE_LABELS, RECO_MODE_LABELS } from '@/lib/cn-agents/types';
import type { EmotionStage, CnRecoMode } from '@/lib/cn-agents/types';

const STABLE_MIN_N = 8;

function meanExcessD5(events: CnRecoEventWithReturns[]): { n: number; mean: number | null } {
  const v = events
    .filter((e) => e.baseline?.status === 'filled')
    .map((e) => e.returns?.excess?.d5)
    .filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x));
  return { n: v.length, mean: v.length > 0 ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null };
}

async function main(): Promise<void> {
  const all = (await loadEventsWithReturns(500)).filter((e) => e.agentSource === 'hard_score_v0' && e.tier !== 'C');
  const dates = [...new Set(all.map((e) => e.date))].sort();
  const splitIdx = Math.floor(dates.length * 0.6);
  const splitDate = dates[splitIdx];
  const train = all.filter((e) => e.date < splitDate);
  const test = all.filter((e) => e.date >= splitDate);
  console.log(`📊 事件 ${all.length}（${dates.length} 交易日）；train < ${splitDate} (${train.length}) / test ≥ (${test.length})`);

  const groupKey = (e: CnRecoEventWithReturns) => `${e.mode}|${e.sentimentPhase}`;
  const keys = [...new Set(all.map(groupKey))];

  const rows: Array<{ mode: string; phase: string; trainN: number; trainEx: number | null; testN: number; testEx: number | null; stable: string }> = [];
  for (const k of keys) {
    const [mode, phase] = k.split('|') as [CnRecoMode, EmotionStage];
    const tr = meanExcessD5(train.filter((e) => groupKey(e) === k));
    const te = meanExcessD5(test.filter((e) => groupKey(e) === k));
    let stable = '—';
    if (tr.mean !== null && te.mean !== null && tr.n >= STABLE_MIN_N && te.n >= STABLE_MIN_N) {
      const sameSign = Math.sign(tr.mean) === Math.sign(te.mean) && tr.mean !== 0;
      stable = sameSign ? (tr.mean > 0 ? '✓正' : '✓負') : '✗翻';
    }
    rows.push({ mode: RECO_MODE_LABELS[mode] ?? mode, phase: STAGE_LABELS[phase] ?? phase, trainN: tr.n, trainEx: tr.mean, testN: te.n, testEx: te.mean, stable });
  }
  rows.sort((a, b) => (b.testEx ?? -99) - (a.testEx ?? -99));
  console.table(rows);

  const stablePos = rows.filter((r) => r.stable === '✓正');
  const stableNeg = rows.filter((r) => r.stable === '✓負');
  console.log(`\n✅ 跨期穩定正 edge（可加分）：${stablePos.map((r) => `${r.mode}×${r.phase}`).join('、') || '無'}`);
  console.log(`❌ 跨期穩定負 edge（可扣分）：${stableNeg.map((r) => `${r.mode}×${r.phase}`).join('、') || '無'}`);
  console.log(`⚠️ 翻號/樣本不足（不調）：${rows.filter((r) => r.stable === '✗翻' || r.stable === '—').length} 格`);
}

main().catch((err) => { console.error(err); process.exit(1); });
