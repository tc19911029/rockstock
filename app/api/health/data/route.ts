/**
 * 數據健康狀態 API
 *
 * GET /api/health/data?market=TW
 * GET /api/health/data?market=CN
 * GET /api/health/data              （兩個市場都返回）
 *
 * 讀取 DownloadVerifier 生成的校驗報告 + L2 快照新鮮度。
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { loadVerifyReport, type VerifyReport } from '@/lib/datasource/DownloadVerifier';
import {
  readIntradaySnapshot,
  getDataSourceStatus,
  getConsecutiveEmptyCount,
  getLastRefreshAttempt,
  type DataSourceStatus,
} from '@/lib/datasource/IntradayCache';
import { getLastTradingDay, isMarketOpen, isPostCloseWindow } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { listScanDates } from '@/lib/storage/scanStorage';
import { checkLimitUpConsistency, type ConsistencySample } from '@/lib/datasource/limitUpConsistency';
import { loadStrategyReadiness, type StrategyReadiness } from '@/lib/health/strategyReadiness';
import { isFinalTradingSnapshot } from '@/lib/health/l1l2Snapshot';
import { getActiveStrategyServer } from '@/lib/strategy/activeStrategyServer';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';

export const runtime = 'nodejs';

interface L2Status {
  /** fresh / stale / missing / pre-market（開盤前 fallback 顯示前一交易日快照） */
  status: 'fresh' | 'stale' | 'missing' | 'pre-market';
  /** 快照中的報價數量 */
  quoteCount: number | null;
  /** 快照年齡（秒） */
  ageSeconds: number | null;
  /** 快照更新時間（數據實際更新時間） */
  updatedAt: string | null;
  /** 最近一次嘗試刷新時間（不論成功或失敗，區分 cron 沒跑 vs API 掛了） */
  lastCheckedAt: string | null;
  /** lastCheckedAt 距今秒數 */
  lastCheckedAgeSeconds: number | null;
}

interface L2SourceInfo {
  /** 各數據源最近一次調用狀態 */
  sources: DataSourceStatus[];
  /** 連續空快照次數（交易日 API 全失敗） */
  consecutiveEmptyCount: number;
  /** 今天是否為交易日 */
  isTradingDay: boolean;
  /** 告警等級 */
  alertLevel: 'none' | 'warning' | 'critical';
}

interface L4Status {
  /** 最新掃描日期 */
  lastScanDate: string | null;
  /** 最新掃描結果數 */
  lastScanCount: number;
  /** 最新掃描時間 */
  lastScanTime: string | null;
  /** 有多少天有掃描紀錄（最多 20） */
  totalDatesAvailable: number;
  /** 今天是否有盤中掃描 */
  todayHasIntraday: boolean;
  /** 最新掃描距今秒數 */
  ageSeconds: number | null;
  /** fresh / stale / missing */
  status: 'fresh' | 'stale' | 'missing';
}

interface MarketHealth {
  market: 'TW' | 'CN';
  /** 最新校驗報告日期 */
  reportDate: string | null;
  /** good / warning / critical / no_report */
  health: string;
  /** 覆蓋率 0-1 */
  coverageRate: number | null;
  /** verify 報告實際母體；避免 30/30 冒充全市場 100%。 */
  totalStocks: number | null;
  stocksCurrent: number | null;
  /** 已由最終快照確認停牌／當日無成交，不需要日 K。 */
  stocksNoTrade: number | null;
  /** 最終快照無該代碼：停止買賣、終止上市流程或尚未開始交易。 */
  stocksNotTrading: number | null;
  /** 有 gap 的股票數 */
  stocksWithGaps: number | null;
  /** 數據過期的股票數 */
  stocksStale: number | null;
  /** 下載失敗的股票數 */
  downloadFailed: number | null;
  /** 報告生成時間 */
  generatedAt: string | null;
  /** L2 快照新鮮度 */
  l2: L2Status;
  /** L2 數據源詳細狀態 */
  l2Sources: L2SourceInfo;
  /** L4 掃描結果狀態 */
  l4: L4Status;
  /** L2 quote 一致性檢查（鎖漲停股 close 是否被誤寫成昨收） */
  limitUpConsistency: LimitUpConsistencyStatus;
  /** L1↔L2 一致性檢查（2026-05-21 加，8358 案發現問題） */
  l1l2Consistency: L1L2ConsistencyStatus;
  /** 啟用中的正式策略是否都產出目標交易日結果。 */
  strategyReadiness: StrategyReadiness;
  /** 完整報告（可選，?detail=1 時返回） */
  report?: VerifyReport;
}

interface LimitUpConsistencyStatus {
  /** 偵測到的「假裝沒漲跌」可疑 quote 數 */
  suspicious: number;
  /** 樣本（最多 10 檔） */
  samples: ConsistencySample[];
  /** alert 等級 */
  level: 'ok' | 'warning' | 'critical';
}

interface L1L2ConsistencyStatus {
  /** 最近一個交易日 L1 vs L2 close 偏差 >1% 的檔數 */
  diff1pct: number;
  /** 偏差 >5% 的檔數 */
  diff5pct: number;
  /** OHLC 不自洽（close 在 [low, high] 範圍外）的檔數 */
  ohlcInconsistent: number;
  /** 檢查總檔數 */
  total: number;
  /** alert 等級 */
  level: 'ok' | 'warning' | 'critical' | 'unavailable';
  /** 無法執行比較時的原因（例如只有盤中快照，沒有收盤快照）。 */
  reason?: string;
  snapshotUpdatedAt?: string;
  /** 樣本（最多 10 檔，偏差最大） */
  samples: Array<{ symbol: string; l1: number; l2: number; pct: number }>;
}

function getTodayDate(market: 'TW' | 'CN'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
  }).format(new Date());
}

async function getL2Status(market: 'TW' | 'CN'): Promise<L2Status> {
  // 週末/假日：看最近交易日的 L2（不是今天，今天不會有檔）
  const today = getTodayDate(market);
  const trading = isTradingDay(today, market);
  const lookupDate = trading ? today : getLastTradingDay(market);
  const snapshot = await readIntradaySnapshot(market, lookupDate);

  // 取得最近一次嘗試刷新時間（不論成功或失敗）
  const lastCheckedAt = getLastRefreshAttempt(market);
  const lastCheckedAgeSeconds = lastCheckedAt
    ? Math.round((Date.now() - new Date(lastCheckedAt).getTime()) / 1000)
    : null;

  if (!snapshot || snapshot.count === 0) {
    // 2026-06-12（QA 提案 #5）：交易日開盤前（TW <09:00 / CN <09:30 當地時間）
    // 今日快照本來就不存在 — fallback 顯示前一交易日快照 + 'pre-market'，
    // 避免每天凌晨/早晨 /health 都亮「missing」誤導。
    if (trading) {
      const hm = new Intl.DateTimeFormat('en-GB', {
        timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date());
      const openHm = market === 'TW' ? '09:00' : '09:30';
      if (hm < openHm) {
        const prevSnap = await readIntradaySnapshot(market, getLastTradingDay(market));
        if (prevSnap && prevSnap.count > 0) {
          return {
            status: 'pre-market',
            quoteCount: prevSnap.count,
            ageSeconds: Math.round((Date.now() - new Date(prevSnap.updatedAt).getTime()) / 1000),
            updatedAt: prevSnap.updatedAt,
            lastCheckedAt,
            lastCheckedAgeSeconds,
          };
        }
      }
    }
    return { status: 'missing', quoteCount: null, ageSeconds: null, updatedAt: null, lastCheckedAt, lastCheckedAgeSeconds };
  }

  const ageMs = Date.now() - new Date(snapshot.updatedAt).getTime();
  const ageSeconds = Math.round(ageMs / 1000);

  // 非交易日沿用最近交易日的收盤快照；交易日必須進一步防「日期是今天、內容停在早盤」。
  const marketOpen = isMarketOpen(market);
  const postCloseWin = isPostCloseWindow(market);
  if (!trading && snapshot.count > 0) {
    return {
      status: 'fresh',
      quoteCount: snapshot.count,
      ageSeconds,
      updatedAt: snapshot.updatedAt,
      lastCheckedAt,
      lastCheckedAgeSeconds,
    };
  }

  const freshness = assessIntradayFreshness(market, snapshot);
  if (!marketOpen && !postCloseWin) {
    return {
      status: freshness.stale ? 'stale' : 'fresh',
      quoteCount: snapshot.count,
      ageSeconds,
      updatedAt: snapshot.updatedAt,
      lastCheckedAt,
      lastCheckedAgeSeconds,
    };
  }

  // 盤中/盤後窗口：用時間判斷新鮮度
  // fresh: <5分鐘 | stale: 5-30分鐘 | missing: >30分鐘
  let status: L2Status['status'] = 'fresh';
  if (ageSeconds > 30 * 60) {
    status = 'missing';
  } else if (ageSeconds > 5 * 60) {
    status = 'stale';
  }

  // 有快照數據時，最差也是 stale（不該是 missing/無數據）
  if (status === 'missing' && snapshot.count > 0) {
    status = 'stale';
  }

  return {
    status,
    quoteCount: snapshot.count,
    ageSeconds,
    updatedAt: snapshot.updatedAt,
    lastCheckedAt,
    lastCheckedAgeSeconds,
  };
}

async function getL4Status(market: 'TW' | 'CN', strategyId: string): Promise<L4Status> {
  const today = getTodayDate(market);
  const marketOpen = isMarketOpen(market);
  const postClose = isPostCloseWindow(market);

  try {
    const entries = await listScanDates(market, 'long', 'daily', strategyId);
    const totalDatesAvailable = entries.length;
    const latest = entries[0] ?? null;
    const todayHasIntraday = entries.some(e => e.date === today);

    if (!latest) {
      return {
        lastScanDate: null, lastScanCount: 0, lastScanTime: null,
        totalDatesAvailable: 0, todayHasIntraday: false,
        ageSeconds: null, status: 'missing',
      };
    }

    const ageSeconds = latest.scanTime
      ? Math.round((Date.now() - new Date(latest.scanTime).getTime()) / 1000)
      : null;

    // 新鮮度判斷
    let status: L4Status['status'] = 'missing';
    if (!marketOpen && !postClose && latest.date === today) {
      // 盤後但有今天的掃描 → fresh（收盤數據）
      status = 'fresh';
    } else if (!marketOpen && !postClose && latest.date !== today) {
      // 盤後但最新不是今天 → 看是否為最近交易日
      const lastTrading = getLastTradingDay(market);
      status = latest.date >= lastTrading ? 'fresh' : 'stale';
    } else if (ageSeconds != null) {
      // 盤中：<10 分鐘 = fresh, 10-30 分鐘 = stale, >30 分鐘 = missing
      if (ageSeconds < 10 * 60) status = 'fresh';
      else if (ageSeconds < 30 * 60) status = 'stale';
      else status = 'missing';
    }

    // 有今天的掃描結果時，最差也是 stale（不該是 missing/無數據）
    // 例如：CN post_close 在盤前 06:53 跑過且有 4 筆結果，盤中 age > 30 min 但數據仍有效
    if (status === 'missing' && latest.date === today && latest.resultCount > 0) {
      status = 'stale';
    }

    return {
      lastScanDate: latest.date,
      lastScanCount: latest.resultCount,
      lastScanTime: latest.scanTime ?? null,
      totalDatesAvailable,
      todayHasIntraday,
      ageSeconds,
      status,
    };
  } catch (err) {
    console.error('[health/data] getL4Status error:', err);
    return {
      lastScanDate: null, lastScanCount: 0, lastScanTime: null,
      totalDatesAvailable: 0, todayHasIntraday: false,
      ageSeconds: null, status: 'missing',
    };
  }
}

async function getLimitUpConsistency(market: 'TW' | 'CN'): Promise<LimitUpConsistencyStatus> {
  const today = getTodayDate(market);
  const trading = isTradingDay(today, market);
  const lookupDate = trading ? today : getLastTradingDay(market);
  const snapshot = await readIntradaySnapshot(market, lookupDate);
  if (!snapshot) {
    return { suspicious: 0, samples: [], level: 'ok' };
  }
  const check = checkLimitUpConsistency(snapshot.quotes as unknown as Parameters<typeof checkLimitUpConsistency>[0]);
  // 任何「假裝沒漲跌」都是嚴重訊號（代表 close resolver 又出包）
  // 1-2 檔 warning（可能罕見邊角），3+ 為 critical（系統性壞掉）
  const level: LimitUpConsistencyStatus['level'] =
    check.suspicious === 0 ? 'ok'
    : check.suspicious <= 2 ? 'warning'
    : 'critical';
  return {
    suspicious: check.suspicious,
    samples: check.samples.slice(0, 10),
    level,
  };
}

async function getL1L2Consistency(market: 'TW' | 'CN'): Promise<L1L2ConsistencyStatus> {
  // 用最近交易日 L1 vs 同日 L2 close 比對。樣本最多 200 檔取個股輪詢
  const lastTrading = getLastTradingDay(market);
  const snapshot = await readIntradaySnapshot(market, lastTrading);
  if (!snapshot || snapshot.quotes.length === 0) {
    return {
      diff1pct: 0, diff5pct: 0, ohlcInconsistent: 0, total: 0,
      level: 'unavailable', reason: '找不到最近交易日的 L2 快照', samples: [],
    };
  }
  if (!isFinalTradingSnapshot(market, lastTrading, snapshot.updatedAt)) {
    return {
      diff1pct: 0, diff5pct: 0, ohlcInconsistent: 0, total: 0,
      level: 'unavailable',
      reason: 'L2 快照早於收盤，不能與收盤日 K 比較',
      snapshotUpdatedAt: snapshot.updatedAt,
      samples: [],
    };
  }
  const { readCandleFile } = await import('@/lib/datasource/CandleStorageAdapter');
  const l2Map = new Map(snapshot.quotes.map(q => [q.symbol, q]));

  // 為避免 health 端 latency 飆，採樣 200 檔（按 turnover 排，TPEx + TSE 都有）
  const samplePool = [...l2Map.entries()]
    .map(([code, q]) => ({ code, q, turnover: q.close * q.volume }))
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, 200);

  let diff1pct = 0;
  let diff5pct = 0;
  let ohlcInconsistent = 0;
  let total = 0;
  const samples: L1L2ConsistencyStatus['samples'] = [];

  await Promise.allSettled(samplePool.map(async ({ code, q }) => {
    // 嘗試 .TW 和 .TWO 後綴（TW 個股都有後綴）
    const suffix = market === 'TW' ? (q.volume > 0 && (await readCandleFile(`${code}.TWO`, market)) ? '.TWO' : '.TW') : (code.startsWith('6') ? '.SS' : '.SZ');
    const existing = await readCandleFile(`${code}${suffix}`, market);
    if (!existing) return;
    const todayCandle = existing.candles.find(c => c.date === lastTrading);
    if (!todayCandle || todayCandle.close <= 0) return;
    total++;
    if (todayCandle.close > todayCandle.high || todayCandle.close < todayCandle.low
        || todayCandle.open > todayCandle.high || todayCandle.open < todayCandle.low) {
      ohlcInconsistent++;
    }
    if (q.close <= 0) return;
    const pct = Math.abs(todayCandle.close - q.close) / Math.max(todayCandle.close, q.close);
    if (pct > 0.05) diff5pct++;
    if (pct > 0.01) {
      diff1pct++;
      if (samples.length < 10) samples.push({ symbol: `${code}${suffix}`, l1: todayCandle.close, l2: q.close, pct: Math.round(pct * 10000) / 100 });
    }
  }));

  samples.sort((a, b) => b.pct - a.pct);
  const level: L1L2ConsistencyStatus['level'] =
    (diff5pct > 5 || ohlcInconsistent > 5) ? 'critical'
    : (diff1pct > 10 || ohlcInconsistent > 0) ? 'warning'
    : 'ok';

  return {
    diff1pct, diff5pct, ohlcInconsistent, total, level,
    snapshotUpdatedAt: snapshot.updatedAt,
    samples,
  };
}

async function getMarketHealth(
  market: 'TW' | 'CN',
  includeDetail: boolean,
  strategyId: string,
): Promise<MarketHealth> {
  const lastTrading = getLastTradingDay(market);

  // L2 + L4 + 一致性檢查 並行讀取
  const l2Promise = getL2Status(market);
  const l4Promise = getL4Status(market, strategyId);
  const consistencyPromise = getLimitUpConsistency(market);
  const l1l2Promise = getL1L2Consistency(market);
  const strategyPromise = loadStrategyReadiness(market, lastTrading, strategyId);

  // 嘗試讀取最近 7 天的報告（可能假日/週末沒報告 — 週一要能回看到上週五）
  let l1Result: Omit<MarketHealth, 'l2' | 'l2Sources' | 'l4' | 'limitUpConsistency' | 'l1l2Consistency' | 'strategyReadiness'> | null = null;
  for (let daysBack = 0; daysBack < 7; daysBack++) {
    const d = new Date(lastTrading + 'T12:00:00');
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toISOString().split('T')[0];

    const report = await loadVerifyReport(market, dateStr);
    if (report) {
      l1Result = {
        market,
        reportDate: dateStr,
        health: report.health,
        coverageRate: report.summary.coverageRate,
        totalStocks: report.summary.totalStocks,
        stocksCurrent: report.summary.stocksCurrent ?? null,
        stocksNoTrade: report.summary.stocksNoTrade ?? 0,
        stocksNotTrading: report.summary.stocksNotTrading ?? 0,
        stocksWithGaps: report.summary.stocksWithGaps,
        stocksStale: report.summary.stocksStale,
        downloadFailed: report.summary.downloadFailed,
        generatedAt: report.generatedAt,
        report: includeDetail ? report : undefined,
      };
      break;
    }
  }

  const [l2, l4, limitUpConsistency, l1l2Consistency, strategyReadiness] = await Promise.all([
    l2Promise, l4Promise, consistencyPromise, l1l2Promise, strategyPromise,
  ]);

  // L2 數據源狀態
  const today = getTodayDate(market);
  const emptyCount = getConsecutiveEmptyCount(market);
  const trading = isTradingDay(today, market);
  const l2ExpectedNow = isMarketOpen(market) || isPostCloseWindow(market);
  let alertLevel: L2SourceInfo['alertLevel'] = 'none';
  // 連續空快照只在盤中／收盤快照窗口有告警意義。盤後 L1 已封存且策略完整時，
  // 將白天最後一次 provider 失敗整晚標 critical 會造成假紅燈；來源歷史仍保留供排查。
  if (trading && l2ExpectedNow && emptyCount >= 3) alertLevel = 'critical';
  else if (trading && l2ExpectedNow && emptyCount >= 1) alertLevel = 'warning';

  const l2Sources: L2SourceInfo = {
    sources: getDataSourceStatus(market),
    consecutiveEmptyCount: emptyCount,
    isTradingDay: trading,
    alertLevel,
  };

  if (l1Result) {
    return { ...l1Result, l2, l2Sources, l4, limitUpConsistency, l1l2Consistency, strategyReadiness };
  }

  return {
    market,
    reportDate: null,
    health: 'no_report',
    coverageRate: null,
    totalStocks: null,
    stocksCurrent: null,
    stocksNoTrade: null,
    stocksNotTrading: null,
    stocksWithGaps: null,
    stocksStale: null,
    downloadFailed: null,
    generatedAt: null,
    l2,
    l2Sources,
    l4,
    limitUpConsistency,
    l1l2Consistency,
    strategyReadiness,
  };
}

export async function GET(req: NextRequest) {
  const market = req.nextUrl.searchParams.get('market') as 'TW' | 'CN' | null;
  const detail = req.nextUrl.searchParams.get('detail') === '1';

  try {
    const strategyId = (await getActiveStrategyServer()).id;
    if (market === 'TW' || market === 'CN') {
      const health = await getMarketHealth(market, detail, strategyId);
      return apiOk(health);
    }

    // 不指定市場：返回兩個市場
    const [tw, cn] = await Promise.all([
      getMarketHealth('TW', detail, strategyId),
      getMarketHealth('CN', detail, strategyId),
    ]);

    return apiOk({ markets: [tw, cn] });
  } catch (err) {
    return apiError(String(err));
  }
}
