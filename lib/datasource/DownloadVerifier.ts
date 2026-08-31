/**
 * DownloadVerifier — L1 下載後自動校驗
 *
 * 在 download-candles cron 完成後，對已下載的 K 線數據進行校驗：
 * 1. 覆蓋率統計 — 成功/失敗/跳過比率
 * 2. Gap 偵測 — detectCandleGaps()
 * 3. lastDate 檢查 — 確認最後日期是否為目標交易日
 * 4. 基本合法性統計 — 報告被 validateCandles 清除的異常K棒數量
 *
 * 報告存到 Blob: reports/verify-{market}-{date}.json
 */

import { readCandleFile } from './CandleStorageAdapter';
import { detectCandleGaps, type CandleGap } from './validateCandles';
import { tradingDaysBetween } from '@/lib/utils/tradingDay';
import { readIntradaySnapshot, type IntradayQuote } from './IntradayCache';
import { isFinalTradingSnapshot } from '@/lib/health/l1l2Snapshot';
import {
  loadBackfillQueue,
  saveBackfillQueue,
  mergeIntoQueue,
  MAX_ATTEMPTS,
} from './BackfillQueue';

const IS_VERCEL = !!process.env.VERCEL;

/**
 * 全市場驗證報告的最低合理母體。
 *
 * verify report 會被策略 coverage guard 當成是否可掃描的依據，因此小型 fallback
 * 清單絕不能寫成「30/30 = 100%」覆蓋掉先前完整報告。
 */
export const MIN_VERIFY_UNIVERSE: Record<'TW' | 'CN', number> = {
  TW: 1500,
  CN: 2700,
};

export function assertCompleteVerifyUniverse(
  market: 'TW' | 'CN',
  symbolCount: number,
): void {
  const minimum = MIN_VERIFY_UNIVERSE[market];
  if (symbolCount < minimum) {
    throw new Error(
      `[DownloadVerifier] ${market} universe=${symbolCount} < ${minimum}; ` +
      '拒絕覆寫全市場 verify report',
    );
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface VerifyGapDetail {
  symbol: string;
  gaps: CandleGap[];
}

export interface VerifyStaleDetail {
  symbol: string;
  lastDate: string;
  daysBehind: number;
}

export interface VerifyNonTradingDetail {
  symbol: string;
  reason: 'no_trade' | 'no_history_or_final_quote';
}

export interface VerifyReport {
  market: 'TW' | 'CN';
  date: string;
  generatedAt: string;
  summary: {
    totalStocks: number;
    downloadSuccess: number;
    downloadFailed: number;
    downloadSkipped: number;
    coverageRate: number;
    /** 真正含 targetDate K 棒的股票數；舊報告可能沒有此欄位 */
    stocksCurrent?: number;
    /** 有 L1、但最後一根早於 targetDate（不含永久停牌）的股票數 */
    stocksMissingTargetDate?: number;
    stocksWithGaps: number;
    /** 近 180 天內的 gap（排除歷史結構性缺口） */
    stocksWithRecentGaps: number;
    stocksStale: number;
    /** 落後 ≥ permanentStaleDays 個交易日（推定永久停牌/退市，不計入 health 警告）— 舊報告可能無此欄位 */
    stocksPermanentStale?: number;
    /** 最終 L2 明確顯示停牌／當日無成交，不應偽造日 K，也不計入活躍分母。 */
    stocksNoTrade?: number;
    /** 全市場最終快照正常，但該代碼尚無歷史檔與即時報價（通常為待上市代碼）。 */
    stocksNotTrading?: number;
    stocksClean: number;
    stocksReadFailed: number;
  };
  failedSymbols: string[];
  gapDetails: VerifyGapDetail[];
  staleDetails: VerifyStaleDetail[];
  /** 永久 stale 的股票清單（retry-failed 應略過）— 舊報告可能無此欄位 */
  permanentStaleDetails?: VerifyStaleDetail[];
  noTradeDetails?: VerifyNonTradingDetail[];
  notTradingDetails?: VerifyNonTradingDetail[];
  health: 'good' | 'warning' | 'critical';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function classifyHealth(
  coverageRate: number,
  stocksWithRecentGaps: number,
  stocksStale: number,
  totalStocks: number,
): 'good' | 'warning' | 'critical' {
  // 只用近 180 天內的 gap 計算，排除歷史結構性缺口（資料收集起始點）
  const recentGapRate = totalStocks > 0 ? stocksWithRecentGaps / totalStocks : 0;
  const staleRate = totalStocks > 0 ? stocksStale / totalStocks : 0;

  if (coverageRate < 0.80 || recentGapRate > 0.10 || staleRate > 0.10) return 'critical';
  if (coverageRate < 0.95 || recentGapRate > 0.02 || staleRate > 0.05) return 'warning';
  return 'good';
}

/**
 * 策略可用覆蓋率：只計算真的含目標交易日 K 棒的活躍股票。
 * 長期停牌／退市不放進分母，避免它們永久壓低市場覆蓋率。
 */
export function calculateTargetDateCoverage(
  totalStocks: number,
  stocksCurrent: number,
  stocksPermanentStale: number,
  stocksNonTrading = 0,
): number {
  const activeStocks = Math.max(0, totalStocks - stocksPermanentStale - stocksNonTrading);
  return activeStocks > 0 ? stocksCurrent / activeStocks : 0;
}

/**
 * 只有最終全市場快照能證明「今天沒有成交」。盤中零量、殘缺快照或單一供應商
 * 查無資料都不能拿來排除，否則真實漏抓會被誤報成正常。
 */
export function isConfirmedNoTradeQuote(
  market: 'TW' | 'CN',
  quote: IntradayQuote,
): boolean {
  if (market === 'TW') {
    // 新快照的 last_actual 可能是沿用昨收／最後成交；只要全日累計量仍為 0，
    // 且本輪不是 actual，就代表官方沒有一根可封的當日 K。舊快照則沿用 false 語意。
    return quote.volume === 0
      && (quote.priceKind === 'last_actual'
        || quote.priceKind === 'indicative'
        || quote.priceKind === 'unavailable'
        || quote.isActualTrade === false);
  }
  const flat = quote.open === quote.high
    && quote.high === quote.low
    && quote.low === quote.close;
  const unchanged = Math.abs(quote.close - quote.prevClose) < 1e-8
    && Math.abs(quote.changePercent) < 1e-8;
  return quote.close > 0 && quote.volume === 0 && flat && unchanged;
}

async function loadFinalSnapshotContext(
  market: 'TW' | 'CN',
  targetDate: string,
): Promise<{ quotes: Map<string, IntradayQuote>; broad: boolean } | null> {
  const snapshot = await readIntradaySnapshot(market, targetDate);
  if (!snapshot || !isFinalTradingSnapshot(market, targetDate, snapshot.updatedAt)) return null;
  const minimum = market === 'TW' ? MIN_VERIFY_UNIVERSE.TW : MIN_VERIFY_UNIVERSE.CN;
  return {
    quotes: new Map(snapshot.quotes.map(quote => [quote.symbol, quote])),
    broad: snapshot.count >= minimum,
  };
}

/** 計算 180 天前的日期字串，用於排除歷史結構性缺口 */
function recentCutoffDate(targetDate: string): string {
  const d = new Date(targetDate + 'T12:00:00');
  d.setDate(d.getDate() - 180);
  return d.toISOString().slice(0, 10);
}

// ── Blob storage ─────────────────────────────────────────────────────────────

function reportBlobKey(market: 'TW' | 'CN', date: string): string {
  return `reports/verify-${market}-${date}.json`;
}

async function saveReportToBlob(report: VerifyReport): Promise<void> {
  const key = reportBlobKey(report.market, report.date);
  const json = JSON.stringify(report);

  if (IS_VERCEL) {
    const { put } = await import('@vercel/blob');
    await put(key, json, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
  }

  // 也存本地（開發環境 + Vercel warm instance）
  try {
    const { mkdir } = await import('fs/promises');
    const { existsSync } = await import('fs');
    const path = await import('path');
    const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
    const dir = path.join(process.cwd(), 'data', 'reports');
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await atomicFsPut(path.join(dir, `verify-${report.market}-${report.date}.json`), json);
  } catch { /* 只讀環境跳過 */ }
}

export async function loadVerifyReport(
  market: 'TW' | 'CN',
  date: string,
): Promise<VerifyReport | null> {
  const key = reportBlobKey(market, date);

  try {
    if (IS_VERCEL) {
      const { get } = await import('@vercel/blob');
      const result = await get(key, { access: 'private' });
      if (!result?.stream) return null;
      const reader = result.stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    } else {
      const { readFile } = await import('fs/promises');
      const path = await import('path');
      const raw = await readFile(
        path.join(process.cwd(), 'data', 'reports', `verify-${market}-${date}.json`),
        'utf-8',
      );
      return JSON.parse(raw);
    }
  } catch {
    return null;
  }
}

// ── Main verify function ─────────────────────────────────────────────────────

interface DownloadStats {
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * 對已下載的 K 線進行校驗，生成報告並存儲。
 *
 * @param market 市場
 * @param targetDate 目標交易日（YYYY-MM-DD）
 * @param symbols 本次下載的全部股票代碼
 * @param stats 下載統計（成功/失敗/跳過）
 * @param maxGapDays gap 偵測門檻（預設 10 天）
 * @param staleDays 落後幾天視為 stale（預設 3 天）
 */
export async function verifyDownload(
  market: 'TW' | 'CN',
  targetDate: string,
  symbols: string[],
  stats: DownloadStats,
  maxGapDays = 10,
  staleDays = 3,
  /** 落後 ≥ N 個交易日 → 推定永久停牌/退市，不算進 stale 警告 */
  permanentStaleDays = 14,
): Promise<VerifyReport> {
  // 呼叫端可能合併多來源清單；先去重，避免重複代號把 30 檔灌成 1,500 筆繞過守門。
  symbols = [...new Set(symbols)];
  // 必須在任何讀檔、queue 更新或報告寫入前 fail closed。這可保證 provider 暫時
  // 退化成少量 fallback 時，舊的完整報告仍被保留，策略也不會誤把小樣本當全市場。
  assertCompleteVerifyUniverse(market, symbols.length);

  const CONCURRENCY = 20;
  const gapDetails: VerifyGapDetail[] = [];
  const staleDetails: VerifyStaleDetail[] = [];
  const permanentStaleDetails: VerifyStaleDetail[] = [];
  const noTradeDetails: VerifyNonTradingDetail[] = [];
  const notTradingDetails: VerifyNonTradingDetail[] = [];
  const failedSymbols: string[] = [];
  let readFailed = 0;
  let stocksCurrent = 0;
  const cutoff = recentCutoffDate(targetDate);
  const finalSnapshot = await loadFinalSnapshotContext(market, targetDate);

  // 批次讀取+校驗（避免一次讀太多 Blob）
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (symbol) => {
        const data = await readCandleFile(symbol, market);
        const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
        const finalQuote = finalSnapshot?.quotes.get(code);
        const confirmedNoTrade = finalQuote
          ? isConfirmedNoTradeQuote(market, finalQuote)
          : false;
        if (!data) {
          if (confirmedNoTrade) {
            noTradeDetails.push({ symbol, reason: 'no_trade' });
            return;
          }
          if (finalSnapshot?.broad && !finalQuote) {
            notTradingDetails.push({ symbol, reason: 'no_history_or_final_quote' });
            return;
          }
          failedSymbols.push(symbol);
          return;
        }

        // Gap 偵測
        const gaps = detectCandleGaps(data.candles, maxGapDays, market);
        if (gaps.length > 0) {
          gapDetails.push({ symbol, gaps });
        }

        // lastDate 檢查
        // 用交易日差距，避免跨連假誤判為 stale
        const behind = tradingDaysBetween(data.lastDate, targetDate, market);
        if (data.lastDate >= targetDate) stocksCurrent++;
        if (data.lastDate < targetDate && confirmedNoTrade) {
          noTradeDetails.push({ symbol, reason: 'no_trade' });
        } else if (data.lastDate < targetDate && finalSnapshot?.broad && !finalQuote) {
          // 完整收盤快照沒有該代碼：可能為停止買賣、終止上市或待上市。
          // 這類股票沒有真實當日 K 棒，必須分流，不能靠昨收偽造平棒補齊。
          notTradingDetails.push({ symbol, reason: 'no_history_or_final_quote' });
        } else if (behind >= permanentStaleDays) {
          // 落後超過 14 個交易日 → 推定永久停牌/退市
          permanentStaleDetails.push({
            symbol,
            lastDate: data.lastDate,
            daysBehind: behind,
          });
        } else if (behind >= staleDays) {
          staleDetails.push({
            symbol,
            lastDate: data.lastDate,
            daysBehind: behind,
          });
        }
      }),
    );

    for (const r of results) {
      if (r.status === 'rejected') readFailed++;
    }
  }

  const totalStocks = symbols.length;
  // Coverage 必須代表「策略今天實際能用的資料」，不能只算檔案存在。
  // 舊算法讓昨天/前天的 K 線也算 covered，曾使 CN 僅約 76% 到最新日仍通過掃描守門。
  // 已確認的長期停牌/退市不列入分母；其餘股票必須真的含 targetDate 才算 covered。
  const stocksNonTrading = noTradeDetails.length + notTradingDetails.length;
  const activeStocks = totalStocks - permanentStaleDetails.length - stocksNonTrading;
  const coverageRate = calculateTargetDateCoverage(
    totalStocks,
    stocksCurrent,
    permanentStaleDetails.length,
    stocksNonTrading,
  );
  const stocksMissingTargetDate = Math.max(
    0,
    activeStocks - stocksCurrent - failedSymbols.length - readFailed,
  );

  // 近期 gap：最後一個 gap 的 toDate >= cutoff（排除資料收集起始點的歷史結構性缺口）
  const recentGapDetails = gapDetails.filter(g => {
    const lastGap = g.gaps[g.gaps.length - 1];
    return lastGap.toDate >= cutoff;
  });

  const report: VerifyReport = {
    market,
    date: targetDate,
    generatedAt: new Date().toISOString(),
    summary: {
      totalStocks,
      downloadSuccess: stats.succeeded,
      downloadFailed: Math.max(0, stats.failed - stocksNonTrading),
      downloadSkipped: stats.skipped,
      coverageRate: +coverageRate.toFixed(4),
      stocksCurrent,
      stocksMissingTargetDate,
      stocksWithGaps: gapDetails.length,
      stocksWithRecentGaps: recentGapDetails.length,
      stocksStale: staleDetails.length,
      stocksPermanentStale: permanentStaleDetails.length,
      stocksNoTrade: noTradeDetails.length,
      stocksNotTrading: notTradingDetails.length,
      stocksClean: totalStocks - gapDetails.length - staleDetails.length - permanentStaleDetails.length - stocksNonTrading - failedSymbols.length - readFailed,
      stocksReadFailed: readFailed + failedSymbols.length,
    },
    failedSymbols,
    gapDetails: gapDetails.slice(0, 50), // 最多記 50 筆 gap detail（避免報告太大）
    staleDetails: staleDetails.slice(0, 50),
    permanentStaleDetails: permanentStaleDetails.slice(0, 100),
    noTradeDetails: noTradeDetails.slice(0, 100),
    notTradingDetails: notTradingDetails.slice(0, 100),
    // 永久 stale 不計入 health 警告（這些是真實停牌/退市）
    health: classifyHealth(coverageRate, recentGapDetails.length, staleDetails.length, totalStocks),
  };

  // 存報告
  await saveReportToBlob(report);

  // ── 更新 BackfillQueue：把本次發現的 gap 寫入隊列，清掉已修復的 ──────────────
  // 下一輪 cron 的 download-candles route 會在 Step -1 消費這個隊列，
  // 針對性補拉缺棒股票（與主下載解耦，三層 fallback 失敗也能 retry）
  try {
    const queue = await loadBackfillQueue(market);
    // 歷史 gap 多半是長期停牌，所有公開來源都會保留相同空窗；只把近 180 天
    // 的缺口排入補拉，避免 2021–2025 的結構性空窗永遠佔住 queue。
    const gapSymbols = new Set(recentGapDetails.map((g) => g.symbol));

    // 清掉已修復的（上次在 queue 但本次 gap=0）
    const before = queue.items.length;
    queue.items = queue.items.filter((it) => gapSymbols.has(it.symbol));
    const cleared = before - queue.items.length;

    // 合併本次發現的 gap
    for (const gd of recentGapDetails) {
      mergeIntoQueue(queue, gd.symbol, gd.gaps);
    }

    await saveBackfillQueue(queue);
    const abandoned = queue.items.filter((it) => it.attempts >= MAX_ATTEMPTS).length;
    console.info(
      `[DownloadVerifier] ${market} ${targetDate}: backfill queue = ${queue.items.length} items ` +
      `(cleared ${cleared}, abandoned ${abandoned})`,
    );
  } catch (err) {
    console.warn('[DownloadVerifier] backfill queue update failed:', err);
  }

  console.info(
    `[DownloadVerifier] ${market} ${targetDate}: ` +
    `health=${report.health} coverage=${(coverageRate * 100).toFixed(1)}% ` +
    `gaps=${gapDetails.length}(recent=${recentGapDetails.length}) stale=${staleDetails.length} ` +
    `noTrade=${stocksNonTrading} readFail=${readFailed + failedSymbols.length}`,
  );

  return report;
}
