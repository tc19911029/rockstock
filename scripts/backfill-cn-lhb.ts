/**
 * 龍虎榜歷史回填 — EM datacenter（支援任意歷史日期，與 push2ex 池的 8 日窗不同）
 *
 * 用法：
 *   npx tsx scripts/backfill-cn-lhb.ts --from 2025-06-13 [--to 2026-06-12] \
 *     [--detail-from 2025-12-13] [--force]
 *
 * 兩級回填：
 *   - 全榜（board-only）：--from 起每交易日 1 發 → 12 個月 ≈ 250 發，半小時內
 *   - 席位明細：date ≥ --detail-from 的日子 withDetail（每上榜股 buy+sell 2 發 ×
 *     600ms 節流；一日 ~100 股 ≈ 2 分鐘；6 個月 ≈ 4-5 小時，通宵跑）
 *
 * 既存檔升級：檔在但 detailFetched=false 且該日 ≥ detail-from → 重組含明細版覆寫。
 * manifest data/cn-agents/_lhb-backfill-manifest.json 可續跑；偶發失敗記 failed 繼續，
 * 重跑本指令自動重試 failed。
 *
 * 注意：EM 榜面 fwd 欄（D1/D5/D10）對「近幾日」是 null（事後才填值）—
 * cn-agents-seats cron 每晚回補近 5 日；歷史日回填時自然已帶值。
 */

import path from 'path';
import { promises as fs } from 'fs';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { assembleLhbDaily } from '@/lib/cn-agents/datasource/emDragonTigerDaily';
import { readLhbDaily, saveLhbDaily } from '@/lib/cn-agents/storage';

const MANIFEST_PATH = path.join(process.cwd(), 'data', 'cn-agents', '_lhb-backfill-manifest.json');
const BOARD_THROTTLE_MS = 600;
const PROGRESS_EVERY = 10;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Manifest {
  done: string[];
  failed: Array<{ date: string; error: string }>;
}

async function loadManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf-8')) as Manifest;
  } catch {
    return { done: [], failed: [] };
  }
}

async function saveManifest(m: Manifest): Promise<void> {
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await atomicFsPut(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

function parseArgs(): { from: string; to: string; detailFrom: string; force: boolean } {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  if (argv.includes('--help')) {
    console.log('用法：npx tsx scripts/backfill-cn-lhb.ts --from YYYY-MM-DD [--to] [--detail-from] [--force]');
    process.exit(0);
  }
  const to = get('--to') ?? getLastTradingDay('CN');
  const defaultFrom = new Date(to + 'T00:00:00Z');
  defaultFrom.setUTCFullYear(defaultFrom.getUTCFullYear() - 1);
  const defaultDetailFrom = new Date(to + 'T00:00:00Z');
  defaultDetailFrom.setUTCMonth(defaultDetailFrom.getUTCMonth() - 6);
  return {
    from: get('--from') ?? defaultFrom.toISOString().slice(0, 10),
    to,
    detailFrom: get('--detail-from') ?? defaultDetailFrom.toISOString().slice(0, 10),
    force: argv.includes('--force'),
  };
}

function* tradingDays(from: string, to: string): Generator<string> {
  const cursor = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    if (isTradingDay(iso, 'CN')) yield iso;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const dates = [...tradingDays(args.from, args.to)];
  console.log(
    `📅 龍虎榜回填 ${args.from} ~ ${args.to}（CN 交易日 ${dates.length} 天）` +
    `；席位明細起點 ${args.detailFrom}${args.force ? '【--force 全部重抓】' : ''}`,
  );

  const manifest = await loadManifest();
  const retrySet = new Set(manifest.failed.map((f) => f.date));
  manifest.failed = [];

  let fetched = 0;
  let upgraded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const wantDetail = date >= args.detailFrom;
    try {
      const existing = args.force ? null : await readLhbDaily(date);
      if (existing) {
        if (existing.detailFetched || !wantDetail) {
          if (!retrySet.has(date)) {
            skipped++;
            continue;
          }
        }
        // 升級路徑：board-only 檔 + 該日要明細 → 整日重組覆寫
      }
      if (fetched + upgraded > 0) await sleep(BOARD_THROTTLE_MS);
      const file = await assembleLhbDaily(date, { withDetail: wantDetail });
      if (file.stocks.length === 0 && date < args.to) {
        // 真 0 筆的交易日罕見（疑假日表誤判）— 照存空檔以免每次重跑都重抓，但記 log
        console.warn(`  ⚠️ ${date} 全榜 0 筆（假日表誤判或 EM 缺檔），照存空檔`);
      }
      await saveLhbDaily(file);
      if (existing) upgraded++;
      else fetched++;
      if (!manifest.done.includes(date)) manifest.done.push(date);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message.slice(0, 140) : String(err);
      manifest.failed.push({ date, error: msg });
      console.warn(`  ⚠️ ${date} 回填失敗：${msg}`);
    }
    if ((i + 1) % PROGRESS_EVERY === 0 || i === dates.length - 1) {
      manifest.done.sort();
      await saveManifest(manifest);
      console.log(`  進度 ${i + 1}/${dates.length}（新抓 ${fetched}、升級 ${upgraded}、跳過 ${skipped}、失敗 ${failed}）`);
    }
  }

  manifest.done.sort();
  await saveManifest(manifest);
  console.log(`🎉 完成：新抓 ${fetched}、升級明細 ${upgraded}、跳過 ${skipped}、失敗 ${failed}`);
  if (failed > 0) console.log('   重跑本指令會自動重試 failed 日期');
}

main().catch((err) => {
  console.error('回填中斷：', err);
  process.exit(1);
});
