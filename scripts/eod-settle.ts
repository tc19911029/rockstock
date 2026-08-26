/**
 * EOD Settlement — 盤後對賬全市場掃描
 *
 * 用法：
 *   npx tsx scripts/eod-settle.ts --market TW --date 2026-05-12
 *   npx tsx scripts/eod-settle.ts --market CN --date 2026-05-12 --dry
 *   npx tsx scripts/eod-settle.ts --market TW --date 2026-05-12 --concurrency 6 --apply
 *
 * 流程：
 *   1. 掃 L1 找出該日 stocklist（從 L1 檔名列表）
 *   2. 對每檔並行打多 vendor、reconcile、產生 SettleResult
 *   3. 報告 status 分佈（settled-multi/single/pending-*）
 *   4. --apply 才寫進 L1
 *   5. 輸出 data/settle-report-{market}-{date}.json 供 T+1 fill 用
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { settleSymbol, type SettleResult, type VendorQuote, type Market } from '../lib/datasource/eodSettle';
import { prefetchVendorBatch } from '../lib/datasource/eodSettleBatch';
import { verifyDownload } from '../lib/datasource/DownloadVerifier';

interface Args {
  market: Market;
  date: string;
  dry: boolean;
  limit: number;
  concurrency: number;
}
function parseArgs(): Args {
  const a: Args = { market: 'TW', date: '', dry: true, limit: Infinity, concurrency: 6 };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === '--market') a.market = process.argv[++i] as Market;
    else if (x === '--date') a.date = process.argv[++i];
    else if (x === '--apply') a.dry = false;
    else if (x === '--limit') a.limit = parseInt(process.argv[++i], 10);
    else if (x === '--concurrency') a.concurrency = parseInt(process.argv[++i], 10);
  }
  if (!a.date) { console.error('--date YYYY-MM-DD required'); process.exit(1); }
  if (a.market !== 'TW' && a.market !== 'CN') { console.error('--market TW|CN'); process.exit(1); }
  return a;
}

async function listSymbols(market: Market): Promise<string[]> {
  const dir = path.join(process.cwd(), 'data', 'candles', market);
  if (!existsSync(dir)) return [];
  const symbols = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
  if (market !== 'TW') return symbols;
  const { expectedTwSymbol } = await import('../lib/datasource/twSymbolMarket');
  const checked = await Promise.all(symbols.map(async symbol => ({ symbol, expected: await expectedTwSymbol(symbol) })));
  return checked.filter(({ symbol, expected }) => !expected || expected === symbol.toUpperCase()).map(({ symbol }) => symbol);
}

function readExisting(market: Market, sym: string, date: string): VendorQuote | undefined {
  const f = path.join(process.cwd(), 'data', 'candles', market, `${sym}.json`);
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    const candles = Array.isArray(raw) ? raw : (raw.candles || []);
    const c = candles.find((c: { date: string }) => c.date === date);
    if (!c) return undefined;
    // OHLC invariant check：close 必須在 [low, high] 範圍內，否則 L1 本身就有 bug
    // 不把這種 L1 當作可信 existing — 讓 vendor 重新覆寫
    const invariantOk = c.high >= c.low && c.high >= c.close && c.low <= c.close && c.high >= c.open && c.low <= c.open;
    if (!invariantOk) {
      process.stdout.write(`  [invariant-violated] ${sym} ${date}: O=${c.open} H=${c.high} L=${c.low} C=${c.close} — 不信 L1，等 vendor 覆寫\n`);
      return undefined;
    }
    return { vendor: 'L1', open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
  } catch { return undefined; }
}

/**
 * eod-settle 由 launchd 的獨立 Node process 寫 L1；常駐 Next server 不會知道磁碟已變更，
 * 可能繼續從記憶體回傳前一交易日（2026-08-26 聯亞 3081 即因此停在 08-25）。
 * 寫入完成後主動通知 server 清 cache。server 沒啟動不影響 settlement 本身。
 */
async function clearServerL1Cache(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn('[eod-settle] CRON_SECRET 未設定，略過常駐服務 L1 cache 失效通知');
    return;
  }

  try {
    const response = await fetch('http://localhost:3000/api/admin/clear-l1-cache', {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn(`[eod-settle] 常駐服務 L1 cache 清除失敗: HTTP ${response.status}`);
      return;
    }
    const payload = await response.json() as { before?: number; after?: number };
    console.log(`[eod-settle] 常駐服務 L1 cache 已清除: ${payload.before ?? '?'} → ${payload.after ?? '?'}`);
  } catch (error) {
    console.warn(`[eod-settle] 常駐服務 L1 cache 失效通知失敗（不影響封存）: ${error instanceof Error ? error.message : error}`);
  }
}

async function main() {
  const { market, date, dry, limit, concurrency } = parseArgs();
  console.log(`EOD Settle: market=${market} date=${date} ${dry ? '(DRY)' : '★ APPLY'} concurrency=${concurrency}`);

  const symbols = (await listSymbols(market)).slice(0, limit);
  console.log(`stocklist 共 ${symbols.length} 檔`);

  // Batch prefetch — TWSE/TPEx/EastMoney 全市場 table（避免 per-symbol 10s 拖死）
  process.stdout.write(`prefetch vendor batch...\n`);
  const t0 = Date.now();
  const batchCache = await prefetchVendorBatch(market, date);
  const bulkN = (batchCache.twseBulk.size + batchCache.tpexBulk.size + batchCache.eastMoneyBulk.size);
  console.log(`  batch cache 完成 (${Date.now()-t0}ms, bulk size=${bulkN})`);

  const results: SettleResult[] = [];
  const stats: Record<string, number> = {
    'settled-multi-source': 0,
    'settled-single-source': 0,
    'pending-multi-disagree': 0,
    'pending-no-vendor-data': 0,
    'pending-unverified': 0,
    'skipped-already-correct': 0,
  };

  let processed = 0, written = 0;
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(async sym => {
      const existing = readExisting(market, sym, date);
      const result = await settleSymbol(sym, market, date, existing, batchCache);

      // 2026-06-12 收緊，TW only（06-11 事故：bulk=0 + FinMind 402 → Yahoo 殘值跟 L1
      // 盤中殘值同源互證，1649 檔誤標 already-correct 且 T+1 不複驗 → 833 檔上櫃假收盤）：
      //   1. 既有 bar 存在但 settled 無官方 bulk 源、也無 ≥2 獨立 vendor 背書
      //      → pending-unverified，不寫不跳過，留給 T+1（08:00 官方 feed 可用、額度重置）。
      //      existing 缺的 gap-fill 路徑保持原行為（單源可寫，tick 守衛仍在）。
      //   2. already-correct 改精確比對 close（原 0.5% 容差讓 58.3 vs 58.4 永久留存），
      //      並加驗 volume（過去 volume 從不對賬 → 盤中部分量永久殘留，污染三色換手率）。
      // CN 維持原規則：CN 無官方 bulk（stub）、實務常只剩騰訊一源，套雙源背書會
      // 整市場 pending（2026-06-12 dry 實測 57/60）、宇宙外補 bar 機制全斷。
      if (market === 'TW') {
        const verified = result.officialAnchor || (result.independentAgree ?? 0) >= 2;
        if (result.settled && existing && !verified) {
          result.status = 'pending-unverified';
        } else if (result.settled && existing) {
          const closeSame = Math.abs(result.settled.close - existing.close) <= 0.001;
          const volSame = existing.volume === result.settled.volume;
          if (closeSame && volSame && existing.volume > 0) {
            result.status = 'skipped-already-correct';
          }
        }
      } else if (result.settled && existing && Math.abs(result.settled.close - existing.close) / Math.max(result.settled.close, existing.close) < 0.005 && existing.volume > 0) {
        result.status = 'skipped-already-correct';
      }
      return result;
    }));

    for (const r of batchResults) {
      results.push(r);
      stats[r.status] = (stats[r.status] ?? 0) + 1;

      // Apply 規則（保守 + 自癒）：
      //   1. settled-multi-source: 兩源以上一致，直接寫
      //   2. settled-single-source + existing 缺/壞: 至少有一個 vendor 比 L1 既有壞掉好，寫
      //   原因：盤中 scan pipeline 偶會寫進 OHLC 內部矛盾的 K（close > high 等），
      //   settlement 必須用 vendor 覆寫，否則「填錯資料」永遠留著
      const existingBad = !readExisting(market, r.symbol, r.date);  // invariant-violated 視為 undefined
      const writable =
        r.officialAnchor === true ||
        r.status === 'settled-multi-source' ||
        (r.status === 'settled-single-source' && existingBad);
      if (!dry && r.settled && writable) {
        const originalStatus = r.status;
        try {
          await saveLocalCandles(r.symbol, market, [{
            date: r.date,
            open: r.settled.open,
            high: r.settled.high,
            low: r.settled.low,
            close: r.settled.close,
            volume: r.settled.volume,
          }], r.officialAnchor ? { trustedOfficial: true } : undefined);
          written++;
        } catch (err) {
          // 單檔壞後綴／IO 問題不得中止全市場；留下 pending 證據後繼續。
          r.status = 'pending-unverified';
          r.warning = [r.warning, `寫入失敗: ${(err as Error).message}`].filter(Boolean).join('；');
          stats['pending-unverified'] = (stats['pending-unverified'] ?? 0) + 1;
          stats[originalStatus] = Math.max(0, (stats[originalStatus] ?? 0) - 1);
          console.warn(`[eod-settle] ${r.symbol} 寫入失敗，已隔離並繼續: ${(err as Error).message}`);
        }
      }
    }
    processed += batch.length;
    if (processed % 50 === 0 || processed >= symbols.length) {
      process.stdout.write(`  進度 ${processed}/${symbols.length} 寫入 ${written}\n`);
    }
  }

  console.log('---');
  console.log('Settlement 分佈:');
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`寫入 L1: ${written}`);

  if (!dry && written > 0) {
    await clearServerL1Cache();
  }

  // 輸出 settle report 供 T+1 fill 用（dry 模式不覆寫，避免 dry 測試把真實 cron 的
  // pending 清單蓋掉 → T+1 會漏補。2026-06-12 修）
  const reportPath = path.join(process.cwd(), 'data', 'settle-reports');
  mkdirSync(reportPath, { recursive: true });
  const reportFile = path.join(reportPath, dry ? `settle-${market}-${date}.dry.json` : `settle-${market}-${date}.json`);
  writeFileSync(reportFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    market, date, dry,
    stats,
    pending: results.filter(r => r.status.startsWith('pending')).map(r => ({
      symbol: r.symbol,
      status: r.status,
      vendors: r.vendors.map(v => `${v.vendor}=${v.close}`),
      disagreements: r.disagreements,
    })),
  }, null, 2));
  console.log(`報告寫入 ${reportFile}`);

  // Apply 結束後立即重建全市場 coverage report。策略閘門只信 verify report；若只寫
  // settle report，另一條下載排程延遲／失敗時，策略會一直讀到昨天或殘缺的驗證狀態。
  // scanner 有自己的完整靜態／本地主檔 fallback，且 DownloadVerifier 會拒絕小母體覆寫。
  let verifyFailed = false;
  if (!dry) {
    try {
      const Scanner = market === 'TW'
        ? (await import('../lib/scanner/TaiwanScanner')).TaiwanScanner
        : (await import('../lib/scanner/ChinaScanner')).ChinaScanner;
      const canonicalSymbols = (await new Scanner().getStockList()).map((stock) => stock.symbol);
      const pendingTotal = stats['pending-multi-disagree'] + stats['pending-no-vendor-data'] + stats['pending-unverified'];
      const verify = await verifyDownload(market, date, canonicalSymbols, {
        succeeded: written,
        failed: pendingTotal,
        skipped: stats['skipped-already-correct'],
      });
      console.log(
        `Verify: ${verify.health} coverage=${(verify.summary.coverageRate * 100).toFixed(1)}% ` +
        `current=${verify.summary.stocksCurrent}/${verify.summary.totalStocks}`,
      );
    } catch (error) {
      verifyFailed = true;
      console.error(`★ verify report 重建失敗: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Invariant：pending 比例 >5% 視為 settlement 失敗
  const pendingTotal = stats['pending-multi-disagree'] + stats['pending-no-vendor-data'] + stats['pending-unverified'];
  const pendingRate = symbols.length > 0 ? pendingTotal / symbols.length : 0;
  if (pendingRate > 0.05 || verifyFailed) {
    if (verifyFailed && pendingRate <= 0.05) {
      console.error('★ settlement 已完成但 verify report 未能安全重建 — exit 1');
    }
  }
  if (pendingRate > 0.05) {
    console.error(`★ pending ${(pendingRate * 100).toFixed(1)}% (${pendingTotal}/${symbols.length}) 超過 5%，settlement 視為部分失敗 — exit 1`);
  }
  if (pendingRate > 0.05 || verifyFailed) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
