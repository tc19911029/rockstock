/**
 * TW L2 盤中救火（Fugle）
 *
 * 使用情境：mis.twse 盤中斷線（HTTP 000 / WAF 封鎖），OpenAPI fallback 回昨日
 * 被日期守門丟光，L2 停在早上 9 點、L4 掃描 0 檔。此腳本繞過 TWSE 直接用
 * Fugle API 抓今日即時報價，組出新的 L2 快照寫回 `data/intraday-TW-<date>.json`。
 *
 * 策略：
 *   1. 讀現有 L2（通常停在 09:08 左右）拿 1800+ 檔 symbol 列表
 *   2. 按 volume 降序取 top N（預設 500），涵蓋掃描會看到的主流檔
 *   3. 逐檔呼叫 Fugle `intraday/quote/{symbol}`（內建 rate limiter ~48/min）
 *   4. 組成 IntradaySnapshot 寫回 L2
 *
 * 預估耗時：500 支 ≈ 10 分鐘；Fugle 免費 60/min。
 *
 * 用法：
 *   npx tsx scripts/rescue-l2-tw-fugle.ts                # top 500
 *   npx tsx scripts/rescue-l2-tw-fugle.ts --top 1000     # top 1000
 */

import { config } from 'dotenv';
import { existsSync, readFileSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { writeIntradaySnapshot, type IntradaySnapshot, type IntradayQuote } from '../lib/datasource/IntradayCache';
import { getFugleQuote, isFugleAvailable } from '../lib/datasource/FugleProvider';

function parseArgs(): { top: number } {
  const args = process.argv.slice(2);
  let top = 500;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--top' && args[i + 1]) {
      top = parseInt(args[++i], 10);
    }
  }
  return { top };
}

function todayTW(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

function readExistingSnapshot(date: string): IntradaySnapshot | null {
  const path = `data/intraday-TW-${date}.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as IntradaySnapshot;
  } catch {
    return null;
  }
}

async function main() {
  const { top } = parseArgs();
  const date = todayTW();

  if (!isFugleAvailable()) {
    console.error('FUGLE_API_KEY 未設定，無法救火。');
    process.exit(1);
  }

  const existing = readExistingSnapshot(date);
  if (!existing || existing.quotes.length === 0) {
    console.error(`L2 檔 data/intraday-TW-${date}.json 不存在或是空的，無法取得 symbol 列表。`);
    console.error('請先等 mis.twse 至少成功一次，或改用其他來源產生初始 L2。');
    process.exit(1);
  }

  const ranked = [...existing.quotes]
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, top);

  console.log(`[rescue] 目標日期: ${date}`);
  console.log(`[rescue] 既有 L2 ${existing.quotes.length} 支，取 top ${ranked.length} 按 volume 排序`);
  console.log(`[rescue] Fugle rate limit ~48/min，預計 ~${Math.ceil(ranked.length / 48)} 分鐘`);

  const nameMap = new Map(existing.quotes.map(q => [q.symbol, q.name]));
  const prevCloseMap = new Map(existing.quotes.map(q => [q.symbol, q.prevClose]));

  const quotes: IntradayQuote[] = [];
  let ok = 0;
  let failed = 0;
  const t0 = Date.now();

  for (let i = 0; i < ranked.length; i++) {
    const symbol = ranked[i].symbol;
    const quote = await getFugleQuote(symbol);

    if (quote && quote.close > 0) {
      const prevClose = prevCloseMap.get(symbol) ?? quote.close;
      const changePercent = prevClose > 0 ? ((quote.close - prevClose) / prevClose) * 100 : 0;
      quotes.push({
        symbol,
        name: quote.name || nameMap.get(symbol) || symbol,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.close,
        volume: quote.volume,
        prevClose,
        changePercent: Math.round(changePercent * 100) / 100,
      });
      ok++;
    } else {
      failed++;
    }

    if ((i + 1) % 50 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[rescue] ${i + 1}/${ranked.length} (ok=${ok}, fail=${failed}, elapsed=${elapsed}s)`);
    }
  }

  if (quotes.length === 0) {
    console.error('[rescue] 沒抓到任何報價，放棄寫入（避免污染 L2）');
    process.exit(1);
  }

  const snapshot: IntradaySnapshot = {
    market: 'TW',
    date,
    updatedAt: new Date().toISOString(),
    count: quotes.length,
    quotes,
  };

  await writeIntradaySnapshot(snapshot);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[rescue] ✅ 寫入 data/intraday-TW-${date}.json — ${quotes.length} 支（ok=${ok}, fail=${failed}, elapsed=${elapsed}s）`);
  console.log(`[rescue] 下一輪 local-cron 掃描會自動吃到新 L2`);
}

main().catch(err => {
  console.error('[rescue] 未預期錯誤:', err);
  process.exit(1);
});
