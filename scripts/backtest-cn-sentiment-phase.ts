/**
 * 陸股情緒週期狀態機回放驗證（唯讀 — 不寫任何檔）
 *
 * 用法：
 *   npx tsx scripts/backtest-cn-sentiment-phase.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * parity 鐵則：與線上同一個 classifyEmotionCycle import 重算全序列 —
 * 不複製任何判定邏輯進本腳本，改 cycle.ts 本腳本自動跟著變。
 * 另比對「重算階段 vs 檔上存的階段」：兩者理論上同（backfill Pass 2 與本腳本
 * 餵同序列），若線上 cron 之後用較短歷史增量推 prev 鏈，可能出現少量差異 → WARN 不 fail。
 *
 * 驗證四件事：
 *   (a) 各階段天數分佈 + 平均 run length（整體 < 2 → WARN：狀態機在抖、hysteresis 失效）
 *   (b) 階段 → 隔日「昨日漲停今日平均」（= 打板接力報酬 proxy；資料就在 breadth 序列內
 *       前移一日：day i 的階段 → day i+1 的 yestLimitUpAvgReturn 即 day i 漲停池隔日表現）。
 *       預期排序 主升 > 啟動 > 修復 ≈ 分歧 > 高潮 > 退潮 > 殺跌，不符印 WARN。
 *       ⚠️ 只取「day i+1 正好是 day i 的次一 CN 交易日」的相鄰對 — 序列有缺日時
 *       day i+1 的「昨日」不是 day i，硬算會把錯位樣本混進桶裡。
 *   (c) 2024-09 關鍵日（若回填涵蓋）：2024-09-24（政策底萬億放量日）當日起 3 個交易日內
 *       必須出現「啟動」或「主升」，否則 exit 1 — 狀態機連史上最明確的情緒反轉都抓不到
 *       就是壞的。
 *   (d) 階段 → 隔日一進二晉級率平均（同 (b) 的相鄰對規則）。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { classifyEmotionCycle } from '@/lib/cn-agents/cycle';
import { STAGE_LABELS } from '@/lib/cn-agents/types';
import type { BreadthDayFile, EmotionStage, MarketBreadthDay } from '@/lib/cn-agents/types';

const BREADTH_DIR = path.join(process.cwd(), 'data', 'cn-agents', 'breadth');
/** 桶均值要進排序檢查的最低樣本數（樣本太少的桶不下排序結論） */
const MIN_SAMPLES_FOR_ORDER = 5;
/** (c) 關鍵日窗：2024-09-24 當日起含後 3 個交易日（共 4 根） */
const KEY_DATE = '2024-09-24';
const KEY_WINDOW = 4;

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(): { from: string | null; to: string | null } {
  const argv = process.argv.slice(2);
  let from: string | null = null;
  let to: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(`情緒週期狀態機回放驗證（唯讀）

用法：npx tsx scripts/backtest-cn-sentiment-phase.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]

讀 data/cn-agents/breadth/*.json 重算階段序列並驗證分佈/排序/2024-09 關鍵日。
先跑 scripts/backfill-cn-breadth.ts 產出 breadth 檔。`);
      process.exit(0);
    } else if (a === '--from' && argv[i + 1]) from = argv[++i];
    else if (a === '--to' && argv[i + 1]) to = argv[++i];
    else { console.error(`❌ 不認識的參數：${a}`); process.exit(1); }
  }
  return { from, to };
}

function nextCnTradingDay(date: string): string {
  const cur = new Date(date + 'T12:00:00');
  for (;;) {
    cur.setDate(cur.getDate() + 1);
    const ds = cur.toISOString().split('T')[0];
    if (isTradingDay(ds, 'CN')) return ds;
  }
}

const mean = (xs: number[]): number | null =>
  xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : null;

const fmt = (v: number | null, digits = 2): string => (v === null ? '—' : v.toFixed(digits));

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { from, to } = parseArgs();

  // 讀全部 breadth 日檔（排除 index.json）
  const files = await fs.readdir(BREADTH_DIR).catch(() => [] as string[]);
  const dayFiles: BreadthDayFile[] = [];
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    if (from && m[1] < from) continue;
    if (to && m[1] > to) continue;
    try {
      dayFiles.push(JSON.parse(await fs.readFile(path.join(BREADTH_DIR, f), 'utf-8')) as BreadthDayFile);
    } catch {
      console.warn(`⚠️ 壞檔跳過：${f}`);
    }
  }
  dayFiles.sort((a, b) => a.date.localeCompare(b.date));
  if (dayFiles.length === 0) {
    console.error('❌ data/cn-agents/breadth/ 沒有任何日檔 — 先跑 npx tsx scripts/backfill-cn-breadth.ts');
    process.exit(1);
  }

  const breadths: MarketBreadthDay[] = dayFiles.map((d) => d.breadth);
  const cycles = classifyEmotionCycle(breadths); // ← 與線上同一個 import（parity）
  const n = cycles.length;
  console.log(`📊 回放 ${n} 個交易日：${dayFiles[0].date} ~ ${dayFiles[n - 1].date}（cycleRulesVersion=${dayFiles[n - 1].cycleRulesVersion}）`);

  // ── parity：重算 vs 檔上存的階段 ──────────────────────────────────────────
  const mismatches: Array<{ date: string; stored: string; recomputed: string }> = [];
  for (let i = 0; i < n; i++) {
    if (dayFiles[i].cycle.stage !== cycles[i].stage) {
      mismatches.push({ date: dayFiles[i].date, stored: dayFiles[i].cycle.stage, recomputed: cycles[i].stage });
    }
  }
  if (mismatches.length > 0) {
    console.warn(`⚠️ parity：重算階段與檔上不一致 ${mismatches.length}/${n} 日（檔上可能是增量 cron 用較短歷史推得）`);
    console.table(mismatches.slice(0, 5));
  } else {
    console.log('✅ parity：重算階段與檔上存的完全一致');
  }

  // ── (a) 階段分佈 + run length ─────────────────────────────────────────────
  const runs: Array<{ stage: EmotionStage; len: number }> = [];
  for (const c of cycles) {
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.stage === c.stage) lastRun.len++;
    else runs.push({ stage: c.stage, len: 1 });
  }
  const allStages = Object.keys(STAGE_LABELS) as EmotionStage[];
  const distRows = allStages.map((s) => {
    const days = cycles.filter((c) => c.stage === s).length;
    const stageRuns = runs.filter((r) => r.stage === s);
    return {
      '階段': STAGE_LABELS[s],
      '天數': days,
      '佔比%': n > 0 ? +((days / n) * 100).toFixed(1) : 0,
      '段數': stageRuns.length,
      '平均連續天數': stageRuns.length > 0 ? +(days / stageRuns.length).toFixed(2) : null,
    };
  });
  console.log('\n(a) 各階段天數分佈 + run length');
  console.table(distRows);
  const avgRunLen = n / runs.length;
  console.log(`整體平均 run length = ${avgRunLen.toFixed(2)}（${runs.length} 段 / ${n} 日）`);
  if (avgRunLen < 2) {
    console.warn('⚠️ WARN：整體平均 run length < 2 — 狀態機單日抖動過頻，hysteresis 疑似失效');
  }

  // ── (b)(d) 階段 → 隔日接力報酬 / 隔日晉級率 ──────────────────────────────
  // 只取「day i+1 正好是 day i 的次一 CN 交易日」的相鄰對（序列缺日時錯位樣本不進桶）
  const relayByStage = new Map<EmotionStage, number[]>();
  const promoByStage = new Map<EmotionStage, number[]>();
  let adjacentPairs = 0;
  for (let i = 0; i < n - 1; i++) {
    if (breadths[i + 1].date !== nextCnTradingDay(breadths[i].date)) continue;
    adjacentPairs++;
    const stage = cycles[i].stage;
    const relay = breadths[i + 1].yestLimitUpAvgReturn; // = day i 漲停池在 day i+1 的平均表現
    if (relay !== null) {
      if (!relayByStage.has(stage)) relayByStage.set(stage, []);
      relayByStage.get(stage)!.push(relay);
    }
    const promo = breadths[i + 1].promotionRate1to2;
    if (promo !== null) {
      if (!promoByStage.has(stage)) promoByStage.set(stage, []);
      promoByStage.get(stage)!.push(promo);
    }
  }
  console.log(`\n(b) 階段 → 隔日打板接力報酬（昨日漲停今日平均 %；相鄰交易日對 ${adjacentPairs}/${n - 1}）`);
  const relayMean = new Map<EmotionStage, { mean: number; n: number }>();
  console.table(
    allStages
      .filter((s) => (relayByStage.get(s) ?? []).length > 0)
      .map((s) => {
        const xs = relayByStage.get(s)!;
        const m = mean(xs)!;
        relayMean.set(s, { mean: m, n: xs.length });
        return { '階段': STAGE_LABELS[s], '樣本數': xs.length, '隔日接力報酬均值%': +m.toFixed(3) };
      }),
  );

  // 預期排序：主升 > 啟動 > 修復 ≈ 分歧 > 高潮 > 退潮 > 殺跌（frozen 不在序內不檢查）
  const tiers: EmotionStage[][] = [['main_rise'], ['launch'], ['repair', 'divergence'], ['climax'], ['retreat'], ['crash']];
  let orderWarns = 0;
  for (let t = 0; t < tiers.length - 1; t++) {
    for (const hi of tiers[t]) {
      for (const lo of tiers[t + 1]) {
        const a = relayMean.get(hi);
        const b = relayMean.get(lo);
        if (!a || !b || a.n < MIN_SAMPLES_FOR_ORDER || b.n < MIN_SAMPLES_FOR_ORDER) continue;
        if (a.mean <= b.mean) {
          orderWarns++;
          console.warn(
            `⚠️ WARN 排序不符：「${STAGE_LABELS[hi]}」隔日接力 ${a.mean.toFixed(3)}% (n=${a.n}) ≤ ` +
            `「${STAGE_LABELS[lo]}」${b.mean.toFixed(3)}% (n=${b.n})`,
          );
        }
      }
    }
  }
  if (orderWarns === 0) {
    console.log('✅ 接力報酬排序符合預期（主升 > 啟動 > 修復≈分歧 > 高潮 > 退潮 > 殺跌；樣本 ≥ 5 的桶）');
  }

  console.log('\n(d) 階段 → 隔日一進二晉級率');
  console.table(
    allStages
      .filter((s) => (promoByStage.get(s) ?? []).length > 0)
      .map((s) => {
        const xs = promoByStage.get(s)!;
        return { '階段': STAGE_LABELS[s], '樣本數': xs.length, '隔日一進二晉級率均值%': +((mean(xs)! * 100).toFixed(1)) };
      }),
  );

  // ── (c) 2024-09 關鍵日 ────────────────────────────────────────────────────
  console.log(`\n(c) 2024-09 關鍵日檢查（${KEY_DATE} 政策底）`);
  const keyIdx = cycles.findIndex((c) => c.date === KEY_DATE);
  if (keyIdx < 0) {
    console.log(`   回填未涵蓋 ${KEY_DATE}，跳過（涵蓋後重跑本腳本驗證）`);
  } else {
    const win = cycles.slice(keyIdx, keyIdx + KEY_WINDOW);
    console.table(win.map((c) => ({
      '日期': c.date,
      '階段': c.stageLabel,
      '情緒分': c.emotionScore,
      '漲停家數': breadths[cycles.indexOf(c)]?.limitUpCount,
    })));
    const hit = win.some((c) => c.stage === 'launch' || c.stage === 'main_rise');
    if (!hit) {
      console.error(`❌ FAIL：${KEY_DATE} 起 ${KEY_WINDOW} 個交易日內未出現「啟動」或「主升」— 狀態機抓不到史上最明確的情緒反轉`);
      process.exit(1);
    }
    console.log('✅ 關鍵日通過：政策底後 3 日內出現 啟動/主升');
  }

  console.log('\n🎉 驗證完成');
}

main().catch((err) => { console.error('❌:', err); process.exit(1); });
