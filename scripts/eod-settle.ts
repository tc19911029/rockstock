/**
 * EOD Settlement — 盤後對賬全市場掃描
 *
 * 用法：
 *   npx tsx scripts/eod-settle.ts --market TW --date 2026-05-12
 *   npx tsx scripts/eod-settle.ts --market CN --date 2026-05-12 --dry
 *   npx tsx scripts/eod-settle.ts --market TW --date 2026-05-12 --concurrency 6 --apply
 *
 * 流程：
 *   1. 掃 L1 檔名並合併當日官方收盤表，建立完整 stocklist
 *   2. 對每檔並行打多 vendor、reconcile、產生 SettleResult
 *   3. 報告 status 分佈（settled-multi/single/pending-*）
 *   4. --apply 才寫進 L1
 *   5. 輸出 data/settle-report-{market}-{date}.json 供 T+1 fill 用
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { settleSymbol, type SettleResult, type VendorQuote, type Market } from '../lib/datasource/eodSettle';
import { prefetchVendorBatch } from '../lib/datasource/eodSettleBatch';
import {
  assessTwOfficialReadiness,
  canWriteSettlement,
  findConfirmedActivePendingSymbols,
  findTwOfficialNoTradeSymbols,
  mergeTwSettlementSymbols,
  shouldNotifySettlementFailure,
} from '../lib/datasource/eodSettlePolicy';
import { readIntradaySnapshot } from '../lib/datasource/IntradayCache';
import { ensureServerL1Visibility, type VisibilityCandidate } from '../lib/datasource/eodSettlementVisibility';
import { verifyDownload } from '../lib/datasource/DownloadVerifier';
import { sendNtfy } from '../lib/notify/ntfy';
import { consumeBackfillQueue } from '../lib/datasource/BackfillConsumer';
import {
  MAX_INLINE_READ_REPAIRS,
  repairReadFailedSymbols,
} from '../lib/datasource/eodReadFailureRepair';

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

interface SettlementState {
  version: 1;
  market: Market;
  date: string;
  status: 'complete' | 'failed' | 'deferred';
  updatedAt: string;
  sentinel?: VisibilityCandidate;
  reason?: string;
}

function settlementStateFile(market: Market, date: string): string {
  return path.join(process.cwd(), 'data', 'settle-reports', `settle-${market}-${date}.state.json`);
}

function readSettlementState(market: Market, date: string): SettlementState | null {
  try {
    const state = JSON.parse(readFileSync(settlementStateFile(market, date), 'utf8')) as SettlementState;
    return state.version === 1 && state.market === market && state.date === date ? state : null;
  } catch { return null; }
}

function writeSettlementState(state: SettlementState): void {
  const file = settlementStateFile(state.market, state.date);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

function visibilityCandidate(market: Market, date: string, symbols: string[]): VisibilityCandidate | null {
  const preferred = market === 'TW' && symbols.includes('3081.TWO')
    ? ['3081.TWO', ...symbols.filter(symbol => symbol !== '3081.TWO')]
    : symbols;
  for (const symbol of preferred) {
    const quote = readExisting(market, symbol, date);
    if (quote?.close && quote.close > 0) return { symbol, date, close: quote.close };
  }
  return null;
}

async function notifySettlementFailure(market: Market, date: string, message: string): Promise<void> {
  const result = await sendNtfy({
    title: `RockStock ${market} 封存失敗`,
    message: `${date} ${message}`,
    tags: ['warning', 'chart_with_downwards_trend'],
    priority: 5,
  });
  if (!result.ok) console.warn(`[eod-settle] ntfy 告警未送達: ${result.reason ?? result.error ?? 'unknown'}`);
}

async function main() {
  const { market, date, dry, limit, concurrency } = parseArgs();
  console.log(`EOD Settle: market=${market} date=${date} ${dry ? '(DRY)' : '★ APPLY'} concurrency=${concurrency}`);

  const fileSymbols = await listSymbols(market);
  let symbols = fileSymbols.slice(0, limit);
  console.log(`stocklist 共 ${symbols.length} 檔`);

  // 常駐 Production 以 eod-settle 取代 download-candles；因此歷史 gap queue
  // 必須在這條正式路徑消費，否則 queue 會永遠停在 attempts=0。
  if (!dry) {
    try {
      const backfill = await consumeBackfillQueue(market, { budgetMs: 30_000 });
      if (backfill.actionable > 0 || backfill.abandoned > 0) {
        console.log(
          `Backfill queue: actionable=${backfill.actionable} filled=${backfill.filled} `
          + `failed=${backfill.failed} skipped=${backfill.skipped} abandoned=${backfill.abandoned}`,
        );
      }
    } catch (error) {
      // 歷史 gap 補拉不能阻斷當日正式收盤封存；queue 保留供下一輪重試。
      console.warn(`Backfill queue 消費失敗，保留到下一輪：${error instanceof Error ? error.message : error}`);
    }
  }

  // 多個 calendar retry 共用完成狀態。已成功的輪次仍會清 cache＋讀回 sentinel，
  // 確認常駐 API 沒有再退回昨天；驗證通過才 cheap exit，避免重打 2000 檔 vendor。
  const previousState = !dry ? readSettlementState(market, date) : null;
  if (previousState?.status === 'complete' && previousState.sentinel) {
    const visibility = await ensureServerL1Visibility({
      secret: process.env.CRON_SECRET,
      candidate: previousState.sentinel,
    });
    if (visibility.ok) {
      console.log(
        `[eod-settle] 已完成且 API 可見：${previousState.sentinel.symbol} `
        + `${previousState.sentinel.date}/${previousState.sentinel.close}（visibility attempt=${visibility.attempts}）`,
      );
      return;
    }
    console.warn(`[eod-settle] 完成狀態存在但 API postcondition 失敗，重新跑全市場：${visibility.error}`);
  }

  // Batch prefetch — TWSE/TPEx/EastMoney 全市場 table（避免 per-symbol 10s 拖死）
  process.stdout.write(`prefetch vendor batch...\n`);
  const t0 = Date.now();
  const batchCache = await prefetchVendorBatch(market, date);
  const bulkN = (batchCache.twseBulk.size + batchCache.tpexBulk.size + batchCache.eastMoneyBulk.size);
  console.log(`  batch cache 完成 (${Date.now()-t0}ms, bulk size=${bulkN})`);

  if (market === 'TW') {
    const mergedSymbols = mergeTwSettlementSymbols(
      fileSymbols,
      batchCache.twseBulk.keys(),
      batchCache.tpexBulk.keys(),
    );
    const added = mergedSymbols.length - fileSymbols.length;
    symbols = mergedSymbols.slice(0, limit);
    if (added > 0) {
      console.log(`[eod-settle] 官方收盤表補入 ${added} 個尚無 L1 檔的新代號（合計 ${symbols.length} 檔）`);
    }
  }

  const officialReadiness = assessTwOfficialReadiness({
    market,
    targetDate: date,
    twseRows: batchCache.twseBulk.size,
    tpexRows: batchCache.tpexBulk.size,
  });
  if (officialReadiness.defer) {
    if (dry) {
      console.warn(`[eod-settle] DRY-DEFER：${officialReadiness.reason}；正式執行會停止封存，但 dry run 繼續供診斷`);
    } else {
      const reportPath = path.join(process.cwd(), 'data', 'settle-reports');
      mkdirSync(reportPath, { recursive: true });
      writeFileSync(path.join(reportPath, `settle-${market}-${date}.deferred.json`), JSON.stringify({
        generatedAt: new Date().toISOString(),
        market,
        date,
        status: 'deferred-official-bulk-incomplete',
        reason: officialReadiness.reason,
        officialRows: {
          twse: batchCache.twseBulk.size,
          tpex: batchCache.tpexBulk.size,
        },
        retryAt: `${date}T16:30:00+08:00`,
      }, null, 2));
      writeSettlementState({
        version: 1,
        market,
        date,
        status: 'deferred',
        updatedAt: new Date().toISOString(),
        reason: officialReadiness.reason,
      });
      console.error(`[eod-settle] DEFER：${officialReadiness.reason}；16:30 retry 再封存，禁止以單一備援源搶先寫正式 L1`);
      process.exit(75);
    }
  }
  if (!officialReadiness.ready && market === 'TW') {
    console.warn(`[eod-settle] DEGRADED：${officialReadiness.reason}；台股只允許已取得官方錨的個股寫入`);
  }

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
      //   1. 既有 bar 存在但 settled 無官方 bulk 源
      //      → pending-unverified，不寫不跳過，留給下一輪官方 feed 補齊。
      //      備援來源即使彼此一致，也只能協助診斷，不能寫成台股正式收盤價。
      //   2. already-correct 改精確比對 close（原 0.5% 容差讓 58.3 vs 58.4 永久留存），
      //      並加驗 volume（過去 volume 從不對賬 → 盤中部分量永久殘留，污染三色換手率）。
      // CN 維持原規則：CN 無官方 bulk（stub）、實務常只剩騰訊一源，套雙源背書會
      // 整市場 pending（2026-06-12 dry 實測 57/60）、宇宙外補 bar 機制全斷。
      if (market === 'TW') {
        const verified = result.officialAnchor === true;
        if (result.settled && !verified) {
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

      // Apply 規則：TW 必須有官方錨；CN 維持多源，缺檔時允許單源自癒。
      const existingBad = !r.existing; // invariant-violated 在 settleSymbol 前已被 readExisting 分流為 undefined
      const writable = canWriteSettlement(r, market, existingBad);
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
  if (!dry) {
    const deferredReport = path.join(reportPath, `settle-${market}-${date}.deferred.json`);
    if (existsSync(deferredReport)) {
      try { unlinkSync(deferredReport); }
      catch (error) { console.warn(`[eod-settle] 無法清除舊 defer report: ${error instanceof Error ? error.message : error}`); }
    }
  }
  console.log(`報告寫入 ${reportFile}`);

  // Apply 結束後立即重建全市場 coverage report。策略閘門只信 verify report；若只寫
  // settle report，另一條下載排程延遲／失敗時，策略會一直讀到昨天或殘缺的驗證狀態。
  // scanner 有自己的完整靜態／本地主檔 fallback，且 DownloadVerifier 會拒絕小母體覆寫。
  let verifyFailed = false;
  let verifyHealth: 'good' | 'warning' | 'critical' | null = null;
  let verifyCoverage: number | null = null;
  let verifyMissingTargetDate: number | null = null;
  let verifyReadFailed: number | null = null;
  let verifyPendingActive: number | null = null;
  if (!dry) {
    try {
      const Scanner = market === 'TW'
        ? (await import('../lib/scanner/TaiwanScanner')).TaiwanScanner
        : (await import('../lib/scanner/ChinaScanner')).ChinaScanner;
      const scanner = new Scanner();
      const canonicalSymbols = (await scanner.getStockList()).map((stock) => stock.symbol);
      const pendingTotal = stats['pending-multi-disagree'] + stats['pending-no-vendor-data'] + stats['pending-unverified'];
      const officialNoTradeSymbols = market === 'TW'
        ? findTwOfficialNoTradeSymbols({
          targetDate: date,
          officialReady: officialReadiness.ready,
          results,
          canonicalSymbols,
          snapshot: await readIntradaySnapshot('TW', date),
        })
        : [];
      if (officialNoTradeSymbols.length > 0) {
        console.log(
          `Verify: 完整官方日線 + 近收盤零量快照確認 ${officialNoTradeSymbols.length} 檔當日無成交`,
        );
      }
      let verify = await verifyDownload(market, date, canonicalSymbols, {
        succeeded: written,
        failed: pendingTotal,
        skipped: stats['skipped-already-correct'],
      }, {
        confirmedNoTradeSymbols: officialNoTradeSymbols,
      });
      if (verify.failedSymbols.length > 0) {
        console.warn(
          `[eod-settle] verify 發現 ${verify.failedSymbols.length} 個 readFailed，先自動重建再二次校驗：`
          + verify.failedSymbols.slice(0, MAX_INLINE_READ_REPAIRS).join(', '),
        );
        const officialQuotes = new Map<string, VendorQuote>();
        for (const result of results) {
          if (result.officialAnchor && result.settled) officialQuotes.set(result.symbol, result.settled);
        }
        const repair = await repairReadFailedSymbols({
          market,
          date,
          symbols: verify.failedSymbols,
          fetchCandles: (symbol, asOfDate) => scanner.fetchCandles(symbol, asOfDate),
          officialQuotes,
        });
        console.warn(
          `[eod-settle] readFailed auto-repair: attempted=${repair.attempted} `
          + `repaired=${repair.repaired} remaining=${repair.failed.length}`,
        );
        if (repair.repaired > 0) {
          verify = await verifyDownload(market, date, canonicalSymbols, {
            succeeded: written + repair.repaired,
            failed: Math.max(0, pendingTotal - repair.repaired),
            skipped: stats['skipped-already-correct'],
          }, {
            confirmedNoTradeSymbols: officialNoTradeSymbols,
          });
        }
      }
      verifyHealth = verify.health;
      verifyCoverage = verify.summary.coverageRate;
      verifyMissingTargetDate = verify.summary.stocksMissingTargetDate ?? 0;
      verifyReadFailed = verify.summary.stocksReadFailed;
      const nonTradingSymbols = new Set([
        ...(verify.noTradeDetails ?? []).map(item => item.symbol),
        ...(verify.notTradingDetails ?? []).map(item => item.symbol),
        ...(verify.permanentStaleDetails ?? []).map(item => item.symbol),
      ]);
      const confirmedActivePending = findConfirmedActivePendingSymbols(
        results,
        canonicalSymbols,
        nonTradingSymbols,
      );
      verifyPendingActive = confirmedActivePending.length;
      const pendingOutsideCanonical = results.filter(result =>
        result.status.startsWith('pending') && !canonicalSymbols.includes(result.symbol)
      ).length;
      if (pendingOutsideCanonical > 0) {
        console.log(
          `Verify: 已排除 ${pendingOutsideCanonical} 個不在當日官方交易母體的 pending `
          + '（停止交易／退市／指數／歷史殘留）',
        );
      }
      if (confirmedActivePending.length > 0) {
        console.warn(
          `Verify: 確認仍在官方交易母體但未完成封存 ${confirmedActivePending.length} 檔：`
          + confirmedActivePending.slice(0, 20).join(', '),
        );
      }
      console.log(
        `Verify: ${verify.health} coverage=${(verify.summary.coverageRate * 100).toFixed(1)}% ` +
        `current=${verify.summary.stocksCurrent}/${verify.summary.totalStocks}`,
      );
    } catch (error) {
      verifyFailed = true;
      console.error(`★ verify report 重建失敗: ${error instanceof Error ? error.message : error}`);
    }
  }

  // 寫磁碟不是完成；常駐 API 必須能讀回相同日期＋收盤價才算完成。
  // 這個 postcondition 直接覆蓋 2026-08-26「聯亞磁碟已是今日、API 還在昨日」事故向量。
  let visibilityFailed = false;
  let sentinel: VisibilityCandidate | null = null;
  if (!dry) {
    sentinel = visibilityCandidate(market, date, symbols);
    if (!sentinel) {
      visibilityFailed = true;
      console.error('★ 找不到可供 API visibility 驗證的當日 L1 sentinel');
    } else {
      const visibility = await ensureServerL1Visibility({
        secret: process.env.CRON_SECRET,
        candidate: sentinel,
      });
      visibilityFailed = !visibility.ok;
      if (visibility.ok) {
        console.log(
          `API visibility: ok ${sentinel.symbol} ${sentinel.date}/${sentinel.close} `
          + `(attempt=${visibility.attempts})`,
        );
      } else {
        console.error(`★ API visibility 驗證失敗: ${visibility.error}`);
      }
    }
  }

  // Invariant：pending 比例 >5% 視為 settlement 失敗
  const pendingTotal = stats['pending-multi-disagree'] + stats['pending-no-vendor-data'] + stats['pending-unverified'];
  const pendingRate = symbols.length > 0 ? pendingTotal / symbols.length : 0;
  if (pendingRate > 0.05 || verifyFailed || visibilityFailed) {
    if (verifyFailed && pendingRate <= 0.05) {
      console.error('★ settlement 已完成但 verify report 未能安全重建 — exit 1');
    }
  }
  if (pendingRate > 0.05) {
    console.error(`★ pending ${(pendingRate * 100).toFixed(1)}% (${pendingTotal}/${symbols.length}) 超過 5%，settlement 視為部分失敗 — exit 1`);
  }
  if (!dry) {
    const complete = pendingRate <= 0.05
      && !verifyFailed
      && !visibilityFailed
      && verifyHealth === 'good'
      && (verifyCoverage ?? 0) >= 0.98
      && verifyMissingTargetDate === 0
      && verifyReadFailed === 0
      && verifyPendingActive === 0
      && sentinel !== null;
    const reason = [
      pendingRate > 0.05 ? `pending=${(pendingRate * 100).toFixed(1)}%` : null,
      verifyFailed ? 'verify rebuild failed' : null,
      verifyHealth && verifyHealth !== 'good' ? `verify=${verifyHealth}` : null,
      verifyCoverage !== null && verifyCoverage < 0.98 ? `coverage=${(verifyCoverage * 100).toFixed(1)}%` : null,
      verifyMissingTargetDate !== null && verifyMissingTargetDate > 0 ? `missingTargetDate=${verifyMissingTargetDate}` : null,
      verifyReadFailed !== null && verifyReadFailed > 0 ? `readFailed=${verifyReadFailed}` : null,
      verifyPendingActive !== null && verifyPendingActive > 0 ? `activeWithoutOfficial=${verifyPendingActive}` : null,
      visibilityFailed ? 'API visibility failed' : null,
    ].filter(Boolean).join(', ');
    const notifyFailure = !complete && shouldNotifySettlementFailure(previousState, reason || 'unknown settlement failure');
    writeSettlementState({
      version: 1,
      market,
      date,
      status: complete ? 'complete' : 'failed',
      updatedAt: new Date().toISOString(),
      sentinel: sentinel ?? undefined,
      reason: reason || undefined,
    });
    if (notifyFailure) {
      await notifySettlementFailure(market, date, reason || 'unknown settlement failure');
    } else if (!complete) {
      console.warn(`[eod-settle] 同日相同失敗原因已通知，略過重複 ntfy：${reason || 'unknown settlement failure'}`);
    }
    if (!complete) process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
