#!/usr/bin/env npx tsx
/**
 * verify-l1-l2-accuracy.ts — 隨機抽樣驗證 L1/L2 數據正確性
 *
 * 對比來源：Yahoo Finance（獨立第三方）
 * 驗證項目：
 *   1. L1 K棒收盤價 vs Yahoo 收盤價（誤差 < 2%）
 *   2. L2 快照收盤價 vs Yahoo 收盤價（誤差 < 2%）
 *   3. L1 最後日期是否為 4/15
 *
 * 用法：
 *   npx tsx scripts/verify-l1-l2-accuracy.ts --market TW --sample 200
 *   npx tsx scripts/verify-l1-l2-accuracy.ts --market CN --sample 200
 */

import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const market = (args.find((_, i) => args[i - 1] === '--market') || 'TW').toUpperCase() as 'TW' | 'CN';
const sampleSize = parseInt(args.find((_, i) => args[i - 1] === '--sample') || '200', 10);

const DATA_ROOT = path.join(process.cwd(), 'data', 'candles', market);
const TARGET_DATE = '2026-04-15';
const BATCH = 10;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Accept: 'application/json',
};

interface VerifyResult {
  symbol: string;
  l1Close: number;
  l1Date: string;
  yahooClose: number;
  yahooDate: string;
  diff: number; // percentage
  l2Close: number | null;
  l2Diff: number | null;
  status: 'ok' | 'mismatch' | 'yahoo_missing' | 'l1_stale';
}

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function fetchYahooClose(symbol: string): Promise<{ close: number; date: string } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d&includePrePost=false`;
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const ts: number[] = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    if (ts.length === 0) return null;
    // Find 4/15 or latest
    for (let i = ts.length - 1; i >= 0; i--) {
      const date = new Date(ts[i] * 1000).toISOString().split('T')[0];
      if (date === TARGET_DATE && closes[i] != null) {
        return { close: +closes[i].toFixed(2), date };
      }
    }
    // Fallback: latest
    const lastIdx = ts.length - 1;
    if (closes[lastIdx] != null) {
      return { close: +closes[lastIdx].toFixed(2), date: new Date(ts[lastIdx] * 1000).toISOString().split('T')[0] };
    }
    return null;
  } catch { return null; }
}

async function main() {
  // Load L2 snapshot
  let l2Map = new Map<string, number>();
  try {
    const snapFile = path.join(process.cwd(), 'data', `intraday-${market}-${TARGET_DATE}.json`);
    const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
    for (const q of snap.quotes) {
      if (q.close > 0) l2Map.set(q.symbol, q.close);
    }
    console.log(`L2 快照載入: ${l2Map.size} 支`);
  } catch { console.log('L2 快照未找到'); }

  // Random sample L1 files
  const files = shuffleArray(readdirSync(DATA_ROOT).filter(f => f.endsWith('.json'))).slice(0, sampleSize);
  console.log(`\n[${market}] 隨機抽 ${files.length} 支驗證（對比 Yahoo Finance）\n`);

  const results: VerifyResult[] = [];
  let yahooMissing = 0;

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (filename) => {
        const filePath = path.join(DATA_ROOT, filename);
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        const lastCandle = data.candles[data.candles.length - 1];
        const symbol = filename.replace('.json', '');
        const pureCode = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

        // L2 close
        const l2Close = l2Map.get(pureCode) ?? null;

        // Yahoo close
        const yahoo = await fetchYahooClose(symbol);

        if (!yahoo) {
          return {
            symbol, l1Close: lastCandle?.close ?? 0, l1Date: lastCandle?.date ?? '',
            yahooClose: 0, yahooDate: '', diff: 0,
            l2Close, l2Diff: null,
            status: 'yahoo_missing' as const,
          };
        }

        const l1Close = lastCandle?.close ?? 0;
        const diff = l1Close > 0 ? Math.abs(l1Close - yahoo.close) / yahoo.close * 100 : 999;
        const l2Diff = l2Close != null && yahoo.close > 0 ? Math.abs(l2Close - yahoo.close) / yahoo.close * 100 : null;

        const status = lastCandle?.date < TARGET_DATE ? 'l1_stale' as const
          : diff > 2 ? 'mismatch' as const
          : 'ok' as const;

        return { symbol, l1Close, l1Date: lastCandle?.date ?? '', yahooClose: yahoo.close, yahooDate: yahoo.date, diff, l2Close, l2Diff, status };
      }),
    );

    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
        if (r.value.status === 'yahoo_missing') yahooMissing++;
      }
    }

    const done = i + batch.length;
    if (done % 50 === 0 || done === files.length) {
      console.log(`  [${done}/${files.length}] 已驗證`);
    }

    if (i + BATCH < files.length) await sleep(500);
  }

  // Summary
  const okCount = results.filter(r => r.status === 'ok').length;
  const mismatch = results.filter(r => r.status === 'mismatch');
  const stale = results.filter(r => r.status === 'l1_stale');
  const verified = results.length - yahooMissing;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${market}] 驗證結果（${TARGET_DATE}）`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  抽樣: ${results.length} 支`);
  console.log(`  Yahoo有數據: ${verified} 支`);
  console.log(`  L1正確 (誤差<2%): ${okCount} 支 (${(okCount / verified * 100).toFixed(1)}%)`);
  console.log(`  L1不匹配 (誤差>2%): ${mismatch.length} 支`);
  console.log(`  L1日期落後: ${stale.length} 支`);
  console.log(`  Yahoo無數據: ${yahooMissing} 支`);

  // L2 accuracy
  const l2Verified = results.filter(r => r.l2Diff != null && r.status !== 'yahoo_missing');
  const l2Ok = l2Verified.filter(r => r.l2Diff! < 2);
  if (l2Verified.length > 0) {
    console.log(`\n  L2正確 (誤差<2%): ${l2Ok.length}/${l2Verified.length} (${(l2Ok.length / l2Verified.length * 100).toFixed(1)}%)`);
  }

  // Show mismatches
  if (mismatch.length > 0) {
    console.log(`\n❌ 不匹配清單:`);
    for (const r of mismatch.slice(0, 20)) {
      console.log(`  ${r.symbol}: L1=${r.l1Close} Yahoo=${r.yahooClose} 差${r.diff.toFixed(1)}% L2=${r.l2Close ?? 'N/A'}`);
    }
  }

  // Show stale
  if (stale.length > 0) {
    console.log(`\n⚠️ 日期落後清單 (前10):`);
    for (const r of stale.slice(0, 10)) {
      console.log(`  ${r.symbol}: L1日期=${r.l1Date} (目標${TARGET_DATE})`);
    }
  }

  // Average diff for OK results
  const avgDiff = results.filter(r => r.status === 'ok').reduce((s, r) => s + r.diff, 0) / Math.max(okCount, 1);
  console.log(`\n  平均誤差: ${avgDiff.toFixed(3)}%`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
