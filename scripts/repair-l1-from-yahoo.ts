/**
 * scripts/repair-l1-from-yahoo.ts
 *
 * 大規模 L1 修補：用 Yahoo Finance 為 ground truth 覆寫 L1 中已知壞掉的 (symbol, date) bar。
 *
 * 用法：
 *   npx tsx scripts/repair-l1-from-yahoo.ts            # dry-run，只報告會改什麼
 *   npx tsx scripts/repair-l1-from-yahoo.ts --apply    # 真正寫入 L1
 *   npx tsx scripts/repair-l1-from-yahoo.ts --apply --symbols=8358.TWO,1233.TW  # 只修指定
 *
 * 來源 (合併三個 audit 清單):
 *   - /tmp/l1-audit/a_violations_v2_trusted.json (1,236 件 L1 vs trusted L2 偏差 >1%)
 *   - /tmp/l1-audit/victims_5_20.json (228 件 5/20 L1 vs Yahoo 偏差 >1%)
 *   - /tmp/l1-audit/b_violations.json (791 件 OHLC 自洽矛盾，主要 2072.TW + 今天 5/21)
 *
 * 流程：
 *   1. 合併、去重成 unique (symbol, dates[])
 *   2. 對每檔抓 Yahoo (1y range 涵蓋多數；2072.TW 5y 涵蓋歷史)
 *   3. 對每個 target date 比對 L1 vs Yahoo close: > 0.5% 或 OHLC 不自洽 → 用 Yahoo 覆寫
 *   4. saveLocalCandles 寫入（會跑新加的 sanitizeOHLC guard）
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import type { Candle } from '../types';

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const SYMBOL_FILTER_ARG = ARGS.find(a => a.startsWith('--symbols='));
const SYMBOL_FILTER = SYMBOL_FILTER_ARG
  ? new Set(SYMBOL_FILTER_ARG.split('=')[1].split(','))
  : null;

type Violation = { market: 'TW' | 'CN'; symbol: string; date: string };

function loadJson(file: string): unknown[] {
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as unknown[];
  } catch { return []; }
}

function collectTargets(): Map<string, { market: 'TW' | 'CN'; dates: Set<string> }> {
  const sources = [
    '/tmp/l1-audit/a_violations_v2_trusted.json',
    '/tmp/l1-audit/victims_5_20.json',
    '/tmp/l1-audit/b_violations.json',
  ];
  const targets = new Map<string, { market: 'TW' | 'CN'; dates: Set<string> }>();
  for (const f of sources) {
    const rows = loadJson(f) as Violation[];
    for (const r of rows) {
      if (!r.symbol || !r.date) continue;
      if (SYMBOL_FILTER && !SYMBOL_FILTER.has(r.symbol)) continue;
      const market = (r.market ?? (r.symbol.endsWith('.SS') || r.symbol.endsWith('.SZ') ? 'CN' : 'TW')) as 'TW' | 'CN';
      const key = `${market}:${r.symbol}`;
      if (!targets.has(key)) targets.set(key, { market, dates: new Set() });
      targets.get(key)!.dates.add(r.date);
    }
  }
  return targets;
}

interface YahooBar { date: string; open: number; high: number; low: number; close: number; volume: number; }

async function yahooFetch(symbol: string, range = '1y'): Promise<YahooBar[]> {
  const url = `https://query1.finance.yahoo.com/v7/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const json = await res.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[] }> } }> } };
    const r0 = json.chart?.result?.[0];
    if (!r0 || !r0.timestamp) return [];
    const ts = r0.timestamp;
    const q = r0.indicators?.quote?.[0];
    if (!q) return [];
    const out: YahooBar[] = [];
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' });
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i] ?? 0;
      if (o == null || h == null || l == null || c == null) continue;
      if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
      const date = fmt.format(new Date(ts[i] * 1000));
      out.push({
        date,
        open: o, high: h, low: l, close: c,
        volume: Math.round(v / 1000),  // Yahoo 給「股」，L1 用「張」
      });
    }
    return out;
  } catch {
    return [];
  }
}

// 是否需要修補：L1 vs Yahoo close 偏差 >0.5% 或 L1 OHLC 自洽矛盾
function needsRepair(l1: Candle, yc: YahooBar): { repair: boolean; reason: string } {
  // OHLC 自洽
  if (l1.close > l1.high || l1.close < l1.low) {
    return { repair: true, reason: `OHLC: close ${l1.close} 超出 [${l1.low}, ${l1.high}]` };
  }
  if (l1.open > l1.high || l1.open < l1.low) {
    return { repair: true, reason: `OHLC: open ${l1.open} 超出 [${l1.low}, ${l1.high}]` };
  }
  // close 偏差
  if (yc.close > 0) {
    const diff = Math.abs(l1.close - yc.close) / Math.max(l1.close, yc.close);
    if (diff > 0.005) {
      return { repair: true, reason: `close ${l1.close} vs Yahoo ${yc.close} 偏 ${(diff*100).toFixed(2)}%` };
    }
  }
  return { repair: false, reason: '' };
}

async function main() {
  console.log(`L1 Yahoo repair — ${APPLY ? 'APPLY MODE' : 'DRY RUN'}`);
  const targets = collectTargets();
  console.log(`Targets: ${targets.size} symbols, ${[...targets.values()].reduce((s, t) => s + t.dates.size, 0)} (symbol, date) 修補目標`);

  if (SYMBOL_FILTER) {
    console.log(`Symbol filter: ${[...SYMBOL_FILTER].join(', ')}`);
  }

  let processed = 0;
  let stocksRepaired = 0;
  let barsRepaired = 0;
  let stocksSkipped = 0;
  let yahooFailed = 0;

  const reasonCounter: Record<string, number> = {};
  const sortedTargets = [...targets.entries()].sort();

  for (const [key, t] of sortedTargets) {
    processed++;
    const { market, dates } = t;
    const [, symbol] = key.split(':');

    // 2072.TW 等歷史壞檔需要更長 range
    const oldestDate = [...dates].sort()[0];
    const yearsBack = Math.max(1, Math.ceil((Date.now() - new Date(oldestDate + 'T00:00:00').getTime()) / (365 * 86400 * 1000)));
    const range = yearsBack >= 2 ? `${Math.min(yearsBack, 5)}y` : '1y';

    const yahooBars = await yahooFetch(symbol, range);
    if (yahooBars.length === 0) {
      yahooFailed++;
      if (processed % 50 === 0 || yahooFailed <= 5) console.log(`  [${processed}/${targets.size}] ${symbol}: Yahoo n/a, skip`);
      continue;
    }
    const yahooByDate = new Map(yahooBars.map(b => [b.date, b]));

    const existing = await readCandleFile(symbol, market);
    if (!existing) {
      stocksSkipped++;
      if (processed % 50 === 0 || stocksSkipped <= 5) console.log(`  [${processed}/${targets.size}] ${symbol}: L1 不存在, skip`);
      continue;
    }

    // 逐 target date 比對、計算要 repair 的
    const candleByDate = new Map(existing.candles.map(c => [c.date, c]));
    const repairsForThisStock: Array<{ date: string; before: Candle; after: YahooBar; reason: string }> = [];
    for (const d of dates) {
      const l1 = candleByDate.get(d);
      const yc = yahooByDate.get(d);
      if (!l1 || !yc) continue;
      const need = needsRepair(l1, yc);
      if (need.repair) {
        repairsForThisStock.push({ date: d, before: l1, after: yc, reason: need.reason });
        reasonCounter[need.reason.split(':')[0]] = (reasonCounter[need.reason.split(':')[0]] ?? 0) + 1;
      }
    }

    if (repairsForThisStock.length === 0) continue;
    stocksRepaired++;
    barsRepaired += repairsForThisStock.length;

    if (processed <= 10 || stocksRepaired % 50 === 0) {
      console.log(`  [${processed}/${targets.size}] ${symbol}: 修補 ${repairsForThisStock.length} 根 (e.g. ${repairsForThisStock[0].date} ${repairsForThisStock[0].reason})`);
    }

    if (APPLY) {
      // 套用：把 candleByDate 對應 date 換成 Yahoo 值，重組 sorted candles 傳給 saveLocalCandles
      for (const r of repairsForThisStock) {
        candleByDate.set(r.date, {
          date: r.date,
          open: r.after.open,
          high: r.after.high,
          low: r.after.low,
          close: r.after.close,
          volume: r.after.volume,
        });
      }
      const finalCandles: Candle[] = [...candleByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      try {
        await saveLocalCandles(symbol, market, finalCandles);
      } catch (err) {
        console.error(`  ${symbol}: save failed —`, err);
      }
    }

    // rate limit
    await new Promise(r => setTimeout(r, 80));
  }

  console.log('\n=== Summary ===');
  console.log(`Symbols processed: ${processed}`);
  console.log(`Symbols repaired:  ${stocksRepaired}`);
  console.log(`Bars  repaired:    ${barsRepaired}`);
  console.log(`Symbols skipped (no L1): ${stocksSkipped}`);
  console.log(`Yahoo fetch failed:      ${yahooFailed}`);
  console.log(`By reason:`);
  for (const [k, n] of Object.entries(reasonCounter).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }
  console.log(APPLY ? '\n✅ APPLY 已完成' : '\n[DRY RUN] 加 --apply 才會真正寫入');

  // 跑完後通知 dev server 清掉 in-memory L1 cache（外部 process 改完檔，dev server 還是舊 cache）
  if (APPLY && stocksRepaired > 0) {
    try {
      const fs = await import('fs');
      const envPath = path.join(process.cwd(), '.env.local');
      const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
      const cronSecret = env.match(/CRON_SECRET=(.+)/)?.[1]?.trim().replace(/^"|"$/g, '');
      if (cronSecret) {
        const res = await fetch('http://localhost:3000/api/admin/clear-l1-cache', {
          headers: { Authorization: `Bearer ${cronSecret}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          console.log('✅ Dev server L1 cache 已清空');
        } else {
          console.log(`(dev server cache clear HTTP ${res.status} — 可能 dev server 未啟動，跳過)`);
        }
      }
    } catch (err) {
      console.log(`(dev server cache clear 失敗 — 可能 dev server 未啟動，跳過: ${err instanceof Error ? err.message : err})`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
