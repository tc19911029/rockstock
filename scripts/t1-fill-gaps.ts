/**
 * T+1 Fill Gaps — 對昨天 settle 完仍 pending 的個股做補洞
 *
 * 為什麼要 T+1：盤後 settle 跑的時候，有些 vendor 還沒 sync（如 EODHD 對某些 .TWO
 * 上櫃可能延遲）。隔天早上再跑一次補洞 — 這時 vendor 都已有昨日資料。
 *
 * 用法：
 *   npx tsx scripts/t1-fill-gaps.ts --market TW --date 2026-05-12
 *   npx tsx scripts/t1-fill-gaps.ts --market TW --date 2026-05-12 --apply
 *
 * 流程：
 *   1. 讀 data/settle-reports/settle-{market}-{date}.json
 *   2. 對每個 pending 股，重新跑 settleSymbol（vendor 重試）
 *   3. 若仍 pending，輸出剩餘清單給用戶手動處理（或之後接 AI WebFetch）
 */
import { config } from 'dotenv';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { settleSymbol, type Market, type VendorQuote } from '../lib/datasource/eodSettle';
import { prefetchVendorBatch } from '../lib/datasource/eodSettleBatch';
import { canWriteSettlement } from '../lib/datasource/eodSettlePolicy';
import { ensureServerL1Visibility, type VisibilityCandidate } from '../lib/datasource/eodSettlementVisibility';
import { getLastTradingDay } from '../lib/datasource/marketHours';
import { sendNtfy } from '../lib/notify/ntfy';
import { readIntradaySnapshot } from '../lib/datasource/IntradayCache';
import { isFinalTradingSnapshot } from '../lib/health/l1l2Snapshot';
import { isConfirmedNoTradeQuote, MIN_VERIFY_UNIVERSE } from '../lib/datasource/DownloadVerifier';

interface Args { market: Market; date: string; apply: boolean; concurrency: number; }
function parseArgs(): Args {
  const a: Args = { market: 'TW', date: '', apply: false, concurrency: 4 };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--market') a.market = process.argv[++i] as Market;
    else if (x === '--date') a.date = process.argv[++i];
    else if (x === '--apply') a.apply = true;
    else if (x === '--concurrency') a.concurrency = parseInt(process.argv[++i], 10);
  }
  if (!a.date) { console.error('--date YYYY-MM-DD required'); process.exit(1); }
  if (a.date === 'auto') a.date = getLastTradingDay(a.market);
  return a;
}

interface PendingEntry {
  symbol: string;
  status: string;
  vendors?: string[];
  disagreements?: string[];
}

function readExisting(market: Market, sym: string, date: string): VendorQuote | undefined {
  const f = path.join(process.cwd(), 'data', 'candles', market, `${sym}.json`);
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    const candles = Array.isArray(raw) ? raw : (raw.candles || []);
    const c = candles.find((c: { date: string }) => c.date === date);
    if (!c) return undefined;
    return { vendor: 'L1', open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
  } catch { return undefined; }
}

async function main() {
  const { market, date, apply, concurrency } = parseArgs();
  const reportFile = path.join(process.cwd(), 'data', 'settle-reports', `settle-${market}-${date}.json`);
  const deferredFile = path.join(process.cwd(), 'data', 'settle-reports', `settle-${market}-${date}.deferred.json`);
  let pending: PendingEntry[];
  if (existsSync(reportFile)) {
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { pending: PendingEntry[] };
    pending = report.pending ?? [];
  } else if (existsSync(deferredFile)) {
    // 同日官方來源整天未發布時只有 deferred report，舊版 T+1 會直接報「找不到 report」後放棄。
    // 現在把全市場當 pending 重跑，確保最壞情況隔日仍可自癒。
    const candleDir = path.join(process.cwd(), 'data', 'candles', market);
    let symbols = readdirSync(candleDir)
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace(/\.json$/, ''));
    if (market === 'TW') {
      const { expectedTwSymbol } = await import('../lib/datasource/twSymbolMarket');
      const checked = await Promise.all(symbols.map(async symbol => ({ symbol, expected: await expectedTwSymbol(symbol) })));
      symbols = checked
        .filter(({ symbol, expected }) => !expected || expected === symbol.toUpperCase())
        .map(({ symbol }) => symbol);
    }
    pending = symbols.map(symbol => ({ symbol, status: 'deferred-full-recovery' }));
    console.warn(`Settle 正式報告缺失但 defer report 存在，啟動全市場 T+1 recovery：${pending.length} 檔`);
  } else {
    const message = `找不到 ${date} settle/deferred report，T+1 無法判定回補母體`;
    console.error(message);
    await sendNtfy({ title: `${market} T+1 回補失敗`, message, tags: ['warning'], priority: 5 });
    process.exit(1);
    return;
  }
  // 指數由 refresh-market-index 專責，不用個股 settlement 的官方錨政策判斷。
  const externalManaged = pending.filter(entry => entry.symbol.startsWith('^'));
  pending = pending.filter(entry => !entry.symbol.startsWith('^'));

  // 最終全市場 L2 明確標示「當日無成交」的股票不應造 K，也不該在 T+1 誤報成漏抓。
  const confirmedNoTrade: PendingEntry[] = [];
  try {
    const snapshot = await readIntradaySnapshot(market, date);
    if (snapshot
      && snapshot.count >= MIN_VERIFY_UNIVERSE[market]
      && isFinalTradingSnapshot(market, date, snapshot.updatedAt)) {
      const quoteMap = new Map(snapshot.quotes.map(quote => [quote.symbol, quote]));
      pending = pending.filter(entry => {
        const code = entry.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
        const quote = quoteMap.get(code);
        if (quote && isConfirmedNoTradeQuote(market, quote)) {
          confirmedNoTrade.push(entry);
          return false;
        }
        return true;
      });
    }
  } catch { /* 無最終 L2 就維持 pending，不能猜成無成交 */ }

  console.log(
    `T+1 fill: market=${market} date=${date} ${apply ? '★ APPLY' : '(DRY)'} `
    + `pending=${pending.length} noTrade=${confirmedNoTrade.length} external=${externalManaged.length}`,
  );

  if (pending.length === 0) {
    console.log('沒有 pending — 無需處理');
    return;
  }

  // 重抓 batch cache（vendor 端可能 sync 了）
  console.log('prefetch vendor batch...');
  const t0 = Date.now();
  const batchCache = await prefetchVendorBatch(market, date);
  console.log(`  done ${Date.now() - t0}ms`);

  const remaining: PendingEntry[] = [];
  const resolvedSettled: Array<{ symbol: string; vendors: string[]; close: number }> = [];
  const resolvedDisagree: Array<{ symbol: string; vendors: string[] }> = [];

  let processed = 0;
  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(async p => {
      const existing = readExisting(market, p.symbol, date);
      const r = await settleSymbol(p.symbol, market, date, existing, batchCache);
      return { p, r, existing };
    }));

    for (const { p, r, existing } of batchResults) {
      const writable = canWriteSettlement(r, market, !existing);
      if (writable && r.settled) {
        resolvedSettled.push({
          symbol: p.symbol,
          vendors: r.vendors.map(v => `${v.vendor}=${v.close}`),
          close: r.settled.close,
        });
        if (apply) {
          await saveLocalCandles(p.symbol, market, [{
            date,
            open: r.settled.open,
            high: r.settled.high,
            low: r.settled.low,
            close: r.settled.close,
            volume: r.settled.volume,
          }], r.officialAnchor ? { trustedOfficial: true } : undefined);
        }
      } else if (r.settled) {
        resolvedDisagree.push({
          symbol: p.symbol,
          vendors: r.vendors.map(v => `${v.vendor}=${v.close}`),
        });
      } else {
        remaining.push({
          symbol: p.symbol,
          status: r.status,
          vendors: r.vendors.map(v => `${v.vendor}=${v.close}`),
          disagreements: r.disagreements,
        });
      }
    }
    processed += batch.length;
    if (processed % 20 === 0 || processed >= pending.length) {
      process.stdout.write(`  ${processed}/${pending.length} (resolved=${resolvedSettled.length}, single=${resolvedDisagree.length}, remain=${remaining.length})\n`);
    }
  }

  console.log('---');
  console.log(`Resolved (通過市場寫入政策, ${apply ? '已寫入' : '可寫入'}): ${resolvedSettled.length}`);
  resolvedSettled.slice(0, 10).forEach(r => console.log(`  ${r.symbol} close=${r.close} (${r.vendors.join(', ')})`));
  console.log(`Single-source 不確定: ${resolvedDisagree.length}`);
  resolvedDisagree.slice(0, 5).forEach(r => console.log(`  ${r.symbol} (${r.vendors.join(', ')})`));
  console.log(`Remain pending: ${remaining.length}`);
  remaining.slice(0, 10).forEach(r => console.log(`  ${r.symbol} ${r.status} (${r.vendors?.join(', ') ?? '無 vendor'})`));

  // 寫剩餘清單到報告
  const t1Report = path.join(process.cwd(), 'data', 'settle-reports', `t1-${market}-${date}.json`);
  mkdirSync(path.dirname(t1Report), { recursive: true });
  writeFileSync(t1Report, JSON.stringify({
    generatedAt: new Date().toISOString(),
    market, date, apply,
    resolvedCount: resolvedSettled.length,
    singleSourceCount: resolvedDisagree.length,
    remainingCount: remaining.length,
    resolved: resolvedSettled,
    singleSource: resolvedDisagree,
    remaining,
    confirmedNoTrade: confirmedNoTrade.map(entry => entry.symbol),
    externalManaged: externalManaged.map(entry => entry.symbol),
  }, null, 2));
  console.log(`報告寫入 ${t1Report}`);

  let visibilityFailed = false;
  if (apply && resolvedSettled.length > 0) {
    const preferred = market === 'TW'
      ? resolvedSettled.find(item => item.symbol === '3081.TWO') ?? resolvedSettled[0]
      : resolvedSettled[0];
    const candidate: VisibilityCandidate = { symbol: preferred.symbol, date, close: preferred.close };
    const visibility = await ensureServerL1Visibility({
      secret: process.env.CRON_SECRET,
      candidate,
    });
    visibilityFailed = !visibility.ok;
    if (visibility.ok) {
      console.log(`API visibility: ok ${candidate.symbol} ${candidate.date}/${candidate.close}`);
    } else {
      console.error(`★ T+1 API visibility 驗證失敗: ${visibility.error}`);
    }
  }

  // 殘留股 → 需要 AI WebFetch 補（這層手動）
  if (remaining.length > 0) {
    console.log('');
    console.log(`★ ${remaining.length} 檔仍 pending — 需要走 AI WebFetch 補（從 stooq / Yahoo 網頁 / 公開財經頁）`);
    console.log(`  symbols: ${remaining.slice(0, 30).map(r => r.symbol).join(', ')}`);
  }

  if (apply && (remaining.length > 0 || resolvedDisagree.length > 0 || visibilityFailed)) {
    const message = `${date} remaining=${remaining.length}, unsafeSingle=${resolvedDisagree.length}, visibilityFailed=${visibilityFailed}`;
    await sendNtfy({ title: `${market} T+1 回補未完成`, message, tags: ['warning'], priority: 5 });
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
