#!/usr/bin/env npx tsx
/**
 * finmind-bulk-prices.ts — 用 FinMind 會員額度批量下載台股全市場日 K（每天一個請求）
 *
 * FinMind TaiwanStockPrice 帶 start_date/end_date（不帶 data_id）會回傳「該日期區間
 * 全市場所有商品」的 OHLCV。會員（SponsorPro）額度 20000 req/hr，一天一請求，
 * 抓數百~上千個交易日也只是幾分鐘。
 *
 * 存成 data/_finmind/TW/{date}.json（per-date，過濾到一般股 + ETF、去除權證）。
 * 這份是「獨立權威來源」，給 scripts/audit-l1-vs-finmind.ts 交叉比對 K 棒/成交量用，
 * 也可拿來修補（repair-l1-from-finmind.ts）。
 *
 * 注意：
 *  - FinMind 成交量單位是「股」（Trading_Volume），本檔原樣保留；audit/repair 端再 ÷1000 換成「張」。
 *  - FinMind high/low 欄位叫 max/min。
 *  - FinMind 價格是「未還權」原始成交價，與 TWSE/TPEx 官方一致（適合對近窗未還權的 L1）。
 *
 * 用法：
 *   npx tsx scripts/finmind-bulk-prices.ts --days 140              # 近 140 天（含假日跳過）
 *   npx tsx scripts/finmind-bulk-prices.ts --from 2021-04-01       # 到今天
 *   npx tsx scripts/finmind-bulk-prices.ts --from 2024-01-01 --to 2026-06-13
 *   npx tsx scripts/finmind-bulk-prices.ts --days 140 --force      # 重抓已存在的日期檔
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const REPO = process.cwd();
const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';
const OUT_DIR = path.join(REPO, 'data', '_finmind', 'TW');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── token ────────────────────────────────────────────────────────────────────
function loadToken(): string {
  const envPath = path.join(REPO, '.env.local');
  if (!existsSync(envPath)) return '';
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^FINMIND_API_TOKEN\s*=\s*(.+)$/);
    if (m) return m[1].replace(/['"]/g, '').trim();
  }
  return '';
}

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const force = a.includes('--force');
  const days = get('--days') ? parseInt(get('--days')!, 10) : undefined;
  let from = get('--from');
  let to = get('--to');
  const today = todayTaipei();
  if (!to) to = today;
  if (!from) {
    if (days) {
      const d = new Date(to + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - days);
      from = d.toISOString().slice(0, 10);
    } else {
      from = '2021-01-01'; // 預設覆蓋我們 L1 中位歷史深度
    }
  }
  return { from: from!, to: to!, force };
}

function todayTaipei(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// ── 我們追蹤的股票宇宙（給 filter 用）───────────────────────────────────────────
function loadUniverse(): Set<string> {
  const dir = path.join(REPO, 'data', 'candles', 'TW');
  const set = new Set<string>();
  if (!existsSync(dir)) return set;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const code = f.replace(/\.(TW|TWO)\.json$/i, '').replace(/\.json$/i, '');
    set.add(code);
  }
  return set;
}

// 一般股（4 碼）+ ETF（4-5 碼純數字），排除權證/牛熊證（6 碼或含字母）。
// 我們已追蹤的代號一律保留（即使是特殊格式）。
function keepCode(code: string, universe: Set<string>): boolean {
  if (universe.has(code)) return true;
  return /^\d{4,5}$/.test(code);
}

interface FMRow {
  date: string;
  stock_id: string;
  Trading_Volume: number;
  Trading_money: number;
  open: number;
  max: number;
  min: number;
  close: number;
}

interface OutBar {
  code: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // 股（原樣）
  money: number;
}

async function fetchDay(token: string, date: string): Promise<FMRow[] | null> {
  const url =
    `${FINMIND_API}?dataset=TaiwanStockPrice&start_date=${date}&end_date=${date}` +
    (token ? `&token=${token}` : '');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.status === 402 || res.status === 429) {
        console.warn(`  [${date}] 限流 ${res.status}，等 60s 重試…`);
        await sleep(60000);
        continue;
      }
      if (!res.ok) {
        console.warn(`  [${date}] HTTP ${res.status}，重試…`);
        await sleep(3000);
        continue;
      }
      const json = (await res.json()) as { status: number; data?: FMRow[] };
      if (json.status !== 200) {
        console.warn(`  [${date}] status ${json.status}，重試…`);
        await sleep(3000);
        continue;
      }
      return json.data ?? [];
    } catch (e) {
      console.warn(`  [${date}] ${(e as Error).message}，重試…`);
      await sleep(3000);
    }
  }
  return null; // 4 次都失敗
}

function* weekdays(from: string, to: string): Generator<string> {
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) yield cur.toISOString().slice(0, 10);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

async function main() {
  const token = loadToken();
  if (!token) {
    console.error('❌ 找不到 FINMIND_API_TOKEN（.env.local），會員額度無法使用，中止。');
    process.exit(1);
  }
  const { from, to, force } = parseArgs();
  const universe = loadUniverse();
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const dates = [...weekdays(from, to)];
  console.log(
    `[finmind-bulk] 範圍 ${from} ~ ${to}（${dates.length} 個平日）｜宇宙 ${universe.size} 檔｜force=${force}`,
  );

  let fetched = 0,
    skipped = 0,
    holiday = 0,
    failed = 0;
  const start = Date.now();

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const outPath = path.join(OUT_DIR, `${date}.json`);
    if (!force && existsSync(outPath)) {
      skipped++;
      continue;
    }

    const rows = await fetchDay(token, date);
    if (rows === null) {
      failed++;
      console.error(`  ❌ ${date} 抓取失敗（4 次重試後放棄）`);
      continue;
    }

    if (rows.length === 0) {
      // 回 0 筆：可能是非交易日，也可能是「當天 EOD 還沒上架」。
      // 對最近 4 天內的日期，不寫死成 holiday（否則 nightly 跑太早會把未上架日永久標成非交易日、之後不補）。
      const ageDays = (Date.parse(todayTaipei()) - Date.parse(date)) / 86400000;
      if (ageDays <= 4) {
        console.log(`  [${date}] 回 0 筆且在近 4 天內 — 可能 EOD 未上架，不寫死、下次重抓`);
        failed++; // 計入待補（非真失敗，但讓摘要提示要再跑）
        await sleep(120);
        continue;
      }
      // 非交易日 → 寫空檔，re-run 時跳過、不再浪費 request
      writeFileSync(
        outPath,
        JSON.stringify({ date, fetchedAt: new Date().toISOString(), tradingDay: false, count: 0, bars: [] }),
        'utf-8',
      );
      holiday++;
    } else {
      const bars: OutBar[] = [];
      for (const r of rows) {
        if (!keepCode(r.stock_id, universe)) continue;
        bars.push({
          code: r.stock_id,
          open: r.open,
          high: r.max,
          low: r.min,
          close: r.close,
          volume: r.Trading_Volume,
          money: r.Trading_money,
        });
      }
      bars.sort((a, b) => a.code.localeCompare(b.code));
      writeFileSync(
        outPath,
        JSON.stringify({
          date,
          fetchedAt: new Date().toISOString(),
          tradingDay: true,
          count: bars.length,
          rawCount: rows.length,
          bars,
        }),
        'utf-8',
      );
      fetched++;
    }

    if ((i + 1) % 20 === 0 || i === dates.length - 1) {
      const el = ((Date.now() - start) / 1000).toFixed(0);
      console.log(
        `  [${i + 1}/${dates.length}] fetched=${fetched} skip=${skipped} holiday=${holiday} fail=${failed} | ${el}s`,
      );
    }
    // 會員額度極寬，給很小的禮貌間隔避免瞬間轟炸
    await sleep(120);
  }

  const el = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\n✅ 完成：新抓 ${fetched}、跳過已存在 ${skipped}、非交易日 ${holiday}、失敗 ${failed}｜${el}s`,
  );
  console.log(`   輸出：${OUT_DIR}`);
  if (failed > 0) console.log(`   ⚠️ 有 ${failed} 天失敗，重跑一次（不帶 --force）會只補失敗的。`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
