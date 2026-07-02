#!/usr/bin/env npx tsx
/**
 * backfill-broker-tw-all.ts — 一次性把「今日主力券商分點」快照補進整個 broker∪inst 宇宙
 *
 * 背景（2026-06-15）：YahooBrokerScraper 之前用純 Node fetch，被 Yahoo 反爬蟲回 3KB stub，
 * 每日 snapshot-broker-tw cron missed:250 → 主力分點集中度卡舊日期。修好（curl fallback）後
 * 用本腳本一次補回今日，之後每日 cron 自然累積。
 *
 * 用法：
 *   npx tsx scripts/backfill-broker-tw-all.ts            # 全 broker∪inst 宇宙
 *   npx tsx scripts/backfill-broker-tw-all.ts 2330 2377  # 指定清單
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { promises as fs } from 'fs';
import path from 'path';
import { fetchYahooBrokerTrades } from '@/lib/datasource/YahooBrokerScraper';
import { appendBrokerDay } from '@/lib/chips/BrokerStorage';

const BROKER_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'broker');
const INST_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'inst');
const CONCURRENCY = 6;

function todayTaipei(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function listCodes(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

async function main() {
  const argCodes = process.argv.slice(2).map(c => c.replace(/\.(TW|TWO)$/i, '').trim()).filter(Boolean);
  let codes: string[];
  if (argCodes.length) {
    codes = argCodes;
  } else {
    const [b, i] = await Promise.all([listCodes(BROKER_DIR), listCodes(INST_DIR)]);
    codes = Array.from(new Set([...b, ...i]));
  }
  const fallbackDate = todayTaipei();
  let written = 0, missed = 0, done = 0;

  for (let k = 0; k < codes.length; k += CONCURRENCY) {
    const chunk = codes.slice(k, k + CONCURRENCY);
    await Promise.all(chunk.map(async code => {
      try {
        const t = await fetchYahooBrokerTrades(code);
        if (!t) { missed++; return; }
        const d = /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : fallbackDate;
        await appendBrokerDay(code, d, {
          netDifference: t.totalDifferenceVolK,
          concentration: +(t.concentration * 100).toFixed(2),
        });
        written++;
      } catch { missed++; }
    }));
    done += chunk.length;
    if (done % 120 === 0 || done >= codes.length) {
      console.log(`[${done}/${codes.length}] written=${written} missed=${missed}`);
    }
  }
  console.log(`\n完成：${codes.length} 檔，寫入 ${written}、抓不到 ${missed}（fallbackDate=${fallbackDate}）`);
}

main();
