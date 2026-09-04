/**
 * 每日收盤後預下載全市場 K 線到本地
 *
 * 用法：
 *   GET /api/cron/download-candles?market=TW
 *   GET /api/cron/download-candles?market=CN
 *
 * Vercel cron schedule:
 *   台股 13:45 CST (UTC 05:45) — 收盤後 15 分鐘
 *   陸股 15:15 CST (UTC 07:15) — 收盤後 15 分鐘
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { TaiwanScanner } from '@/lib/scanner/TaiwanScanner';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { suspectsGrossJump, isTwListingTransition } from '@/lib/datasource/limitMoveGuard';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { saveDownloadManifest } from '@/lib/datasource/DownloadManifest';
import { verifyDownload, MIN_VERIFY_UNIVERSE } from '@/lib/datasource/DownloadVerifier';
import { spotCheckL1 } from '@/lib/datasource/L1SpotCheck';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { consumeBackfillQueue } from '@/lib/datasource/BackfillConsumer';
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';
import { rocDateToAd } from '@/lib/datasource/eodSettleBatch';

// ── TWSE MI_INDEX 官方日收盤（上市，集合競價後才更新） ───────────────────────────

interface BulkOHLCV { open: number; high: number; low: number; close: number; volume: number; }

/**
 * 抓 TWSE MI_INDEX table 8「每日收盤行情」，一次取所有上市股票的官方 OHLCV。
 * 用來替代 L2 盤中快照，避免集合競價前的快照寫入錯誤收盤價。
 */
async function fetchTWSEBulkClose(dateStr: string): Promise<Map<string, BulkOHLCV>> {
  const d = dateStr.replace(/-/g, ''); // "2026-04-29" → "20260429"
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${d}&type=ALLBUT0999`;
  // 2026-05-11：Node fetch 對 www.twse.com.tw 也可能被 Cloudflare 擋，走 fetchJsonWithCurlFallback
  const { data, source } = await fetchJsonWithCurlFallback<{ stat: string; tables: Array<{ fields: string[]; data: string[][] }> }>(
    url, { timeoutMs: 30_000 },
  );
  if (source === 'curl') console.info('[download-candles] TWSE MI_INDEX 經 curl fallback 成功');
  if (data.stat !== 'OK') throw new Error(`TWSE MI_INDEX stat=${data.stat}`);

  // 2026-06-13：TWSE 改過 MI_INDEX 表格結構（成交筆數/成交金額對調、表格數量會變），
  // 原本寫死 tables[8] + 欄位位置 row[5..8] 在改版日會「整批錯位」（代號對到別檔的價），
  // 而且因為注入與稽核用同一份壞 map → 交叉稽核還會誤判「全部一致」。
  // 改成「靠欄位名稱定位」：先找出含『證券代號』+『收盤價』的那張表，再用 fields 索引取欄位。
  const tables = data.tables ?? [];
  const idxOf = (fields: string[], ...names: string[]) =>
    fields.findIndex(f => { const t = f.replace(/\s/g, ''); return names.some(n => t === n); });
  const stockTable = tables.find(t =>
    Array.isArray(t.fields) && idxOf(t.fields, '證券代號') >= 0 && idxOf(t.fields, '收盤價') >= 0
    && Array.isArray(t.data) && t.data.length > 100);
  if (!stockTable) throw new Error('TWSE MI_INDEX 找不到「每日收盤行情」股票表（結構可能再次改版）');
  const F = stockTable.fields;
  const cCode = idxOf(F, '證券代號'), cOpen = idxOf(F, '開盤價'), cHigh = idxOf(F, '最高價'),
        cLow = idxOf(F, '最低價'), cClose = idxOf(F, '收盤價'), cVol = idxOf(F, '成交股數');
  if ([cCode, cOpen, cHigh, cLow, cClose, cVol].some(i => i < 0))
    throw new Error(`TWSE MI_INDEX 欄位缺失 fields=${JSON.stringify(F)}`);

  const parseNum = (s: string) => { const n = parseFloat(String(s).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, BulkOHLCV>();
  for (const row of stockTable.data) {
    const code = row[cCode]?.trim();
    if (!code || !/^\d{4,}[A-Z]?$/.test(code)) continue; // 只要 4~5 位數字（含 ETF 如 00400A）
    const open  = parseNum(row[cOpen]);
    const high  = parseNum(row[cHigh]);
    const low   = parseNum(row[cLow]);
    const close = parseNum(row[cClose]);
    const volume = Math.round(parseNum(row[cVol]) / 1000); // 股 → 張
    if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
  }
  return map;
}

// ── TPEx 上櫃官方日收盤（集合競價後才更新）──────────────────────────────────
/**
 * 抓 TPEx OpenAPI tpex_mainboard_quotes，所有上櫃股票最新交易日 OHLCV。
 * 跟 TWSE MI_INDEX 平行，給 .TWO 上櫃股當 ground truth 安全網。
 *
 * 注意：endpoint 只回最新交易日資料（不能指定歷史日期）；用 dateStr 比對 row.Date
 *      確保抓到的是目標交易日。TPEx 結算約 14:00 CST 完成。
 */
interface TPExRawRow {
  Date?: string; SecuritiesCompanyCode?: string;
  Open?: string; High?: string; Low?: string; Close?: string;
  TradingShares?: string;
}
async function fetchTPExBulkClose(targetDate: string): Promise<Map<string, BulkOHLCV>> {
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes';
  // 2026-05-11：Node fetch 對 TPEx 被 Cloudflare 擋（5/11 cron 漏 853 支上櫃的元兇），走 curl fallback
  const { data: rows, source } = await fetchJsonWithCurlFallback<TPExRawRow[]>(url, { timeoutMs: 30_000 });
  if (source === 'curl') console.info('[download-candles] TPEx OpenAPI 經 curl fallback 成功');
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('TPEx OpenAPI empty');

  const parseNum = (s?: string) => { if (!s) return 0; const n = parseFloat(s.replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const map = new Map<string, BulkOHLCV>();
  let dateMatched = 0;
  for (const row of rows) {
    const code = row.SecuritiesCompanyCode?.trim();
    if (!code || !/^\d{4,5}[A-Z]?$/.test(code)) continue;
    // 只接受目標日的資料（避免跑在交易日 cron 太早撈到前一日 stale 結果）
    const rowDate = rocDateToAd(row.Date);
    if (rowDate !== targetDate) continue;
    dateMatched++;
    const open = parseNum(row.Open);
    const high = parseNum(row.High);
    const low = parseNum(row.Low);
    const close = parseNum(row.Close);
    const volume = Math.round(parseNum(row.TradingShares) / 1000); // 股 → 張
    if (close > 0 && open > 0) map.set(code, { open, high, low, close, volume });
  }
  if (dateMatched === 0) throw new Error(`TPEx OpenAPI 無 ${targetDate} 資料（可能還沒結算）`);
  return map;
}

export const runtime = 'nodejs';
export const maxDuration = 300;

const CONCURRENCY = 8;
const BATCH_DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type DownloadGlobal = typeof globalThis & {
  __rockstockDownloadInFlight?: Set<'TW' | 'CN'>;
};
const downloadGlobal = globalThis as DownloadGlobal;
const downloadInFlight = downloadGlobal.__rockstockDownloadInFlight ??= new Set();

export async function GET(req: NextRequest) {
  // 驗證 cron secret
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = req.nextUrl.searchParams.get('market') as 'TW' | 'CN' | null;
  if (market !== 'TW' && market !== 'CN') {
    return apiError('market must be TW or CN', 400);
  }
  if (downloadInFlight.size > 0) {
    const activeMarket = [...downloadInFlight][0];
    return apiError(`${activeMarket} download already in flight`, 409);
  }
  downloadInFlight.add(market);

  const startTime = Date.now();
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();

  const lastTradingDate = getLastTradingDay(market);

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const stocks = await scanner.getStockList();

    // Stocklist size hard guard：5/11 教訓 — cron 14:37 CST 跑時 TPEx openapi 暫時掛掉，
    // stocklist 只回上市 1077（少了 853 支上櫃），但 ScanPipeline 安全閘 (200) 沒擋住，
    // 結果 853 支上櫃股的 5/11 row 完全沒下載。這裡用近期 manifest 平均 vs 本次大小做監測。
    const expectedMin = MIN_VERIFY_UNIVERSE[market];
    if (stocks.length < expectedMin) {
      throw new Error(
        `${market} stocklist=${stocks.length} < ${expectedMin}; ` +
        '拒絕執行部分市場下載，並保留既有完整 verify report',
      );
    }

    // ── Step -1: 消費 Backfill Queue（上輪 verify 發現缺棒的股票，針對性補拉） ──
    // 在主下載之前跑，補拉也會觸發 writeCandleFile merge，讓主下載看到已補齊狀態。
    // 預算：此步驟 30 秒內結束，超過就剩餘留到下一輪。
    let backfillFilled = 0;
    let backfillFailed = 0;
    let backfillSkipped = 0;
    try {
      const backfill = await consumeBackfillQueue(market, { budgetMs: 30_000 });
      backfillFilled = backfill.filled;
      backfillFailed = backfill.failed;
      backfillSkipped = backfill.skipped;
      if (backfill.actionable > 0) {
        console.info(`[download-candles] ${market}: backfill queue = ${backfill.actionable} actionable items`);
      }
      if (backfillFilled > 0 || backfillFailed > 0) {
        console.info(
          `[download-candles] ${market}: backfill 完成 — ${backfillFilled} 補齊, ${backfillFailed} 失敗, ${backfillSkipped} 跳過`,
        );
      }
    } catch (err) {
      console.warn('[download-candles] backfill consume failed:', err);
    }

    // ── TW 上市：TWSE MI_INDEX 官方日收盤（集合競價後才更新，是唯一正確來源）──
    // 取代 L2 盤中快照，避免快照在集合競價完成前就注入錯誤收盤價
    let twseMap: Map<string, BulkOHLCV> | null = null;
    let twseInjected = 0;
    if (market === 'TW') {
      try {
        twseMap = await fetchTWSEBulkClose(lastTradingDate);
        console.info(`[download-candles] TW: TWSE MI_INDEX 官方收盤已載入 ${twseMap.size} 支上市股票`);
      } catch (err) {
        console.warn('[download-candles] TW: TWSE MI_INDEX 載入失敗，改用 L2+API fallback:', err);
      }
    }

    // ── TW 上櫃：TPEx OpenAPI 官方日收盤（給 .TWO 當 ground truth，平行 TWSE 安全網）──
    // 0510 加：原本 .TWO 只能靠 data provider，13:45 cron 抓到的可能是盤中快照
    let tpexMap: Map<string, BulkOHLCV> | null = null;
    let tpexInjected = 0;
    if (market === 'TW') {
      try {
        tpexMap = await fetchTPExBulkClose(lastTradingDate);
        console.info(`[download-candles] TW: TPEx OpenAPI 官方收盤已載入 ${tpexMap.size} 支上櫃股票`);
      } catch (err) {
        console.warn('[download-candles] TW: TPEx OpenAPI 載入失敗（可能還沒結算），改用 L2+API fallback:', err);
      }
    }

    // 正式盤後下載禁用 L2。L2 沒有 sealed/final 標記，可能凍結在午盤；
    // 官方 bulk 缺漏時必須走歷史日 K provider，不能用半根日 K 補正式 L1。
    const l2Injected = 0;

    console.info(
      `[download-candles] ${market}: ${stocks.length} 支，` +
      `TWSE=${twseMap?.size ?? 0}，TPEx=${tpexMap?.size ?? 0}，L2=disabled(post_close)`
    );

    // 收集每支失敗的 symbol + 原因，供 manifest 寫入（2026-05-11：原本只記計數
    // 導致 5/11 cron 失敗 5 支時根本不知道是哪 5 支）
    const failedSymbols: Array<{ symbol: string; reason: string }> = [];

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async ({ symbol }): Promise<number | { failed: true; reason: string }> => {
          const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const existing = await readCandleFile(symbol, market);

          // 已是最新就跳過 —— 但若有官方 bulk(MI_INDEX/TPEx)資料，仍要用它覆蓋今日 bar：
          // 先前可能是 intraday/L2 partial 量先寫入(成交量偏少)，集合競價後的官方收盤才準。
          // （這是「同日內官方蓋掉盤中」，非「盤中蓋封存歷史」，不違反鐵則 #1。）
          const hasAuthoritative =
            (symbol.endsWith('.TW') && !!twseMap?.has(code)) ||
            (symbol.endsWith('.TWO') && !!tpexMap?.has(code));
          if (existing && existing.lastDate > lastTradingDate && !hasAuthoritative) return -1;

          // ── 優先路徑 1：TWSE 官方日收盤（只對上市 .TW 股票）──
          // 用集合競價後的官方 OHLCV，不受盤中快照時序影響
          // 防呆：官方 bulk 若因來源改版錯位寫出「不可能跳動」(>50% 偏離前收)，跳過改走完整 API
          const prevClose = existing?.candles?.[existing.candles.length - 1]?.close;
          const prevBar = existing?.candles?.[existing.candles.length - 1];
          if (symbol.endsWith('.TW') && twseMap) {
            const ohlcv = twseMap.get(code);
            if (ohlcv) {
              if (suspectsGrossJump(prevClose, ohlcv) && !isTwListingTransition(symbol, prevBar, ohlcv)) {
                console.warn(`[download-candles] ${symbol} ${lastTradingDate} TWSE bulk 異常跳動(prev=${prevClose}→${ohlcv.close})，跳過官方注入改走 API`);
              } else {
                await saveLocalCandles(symbol, market, [{ date: lastTradingDate, ...ohlcv }], { trustedOfficial: true });
                twseInjected++;
                return 1;
              }
            }
          }

          // ── 優先路徑 1b：TPEx 官方日收盤（只對上櫃 .TWO 股票）──
          if (symbol.endsWith('.TWO') && tpexMap) {
            const ohlcv = tpexMap.get(code);
            if (ohlcv) {
              if (suspectsGrossJump(prevClose, ohlcv) && !isTwListingTransition(symbol, prevBar, ohlcv)) {
                console.warn(`[download-candles] ${symbol} ${lastTradingDate} TPEx bulk 異常跳動(prev=${prevClose}→${ohlcv.close})，跳過官方注入改走 API`);
              } else {
                await saveLocalCandles(symbol, market, [{ date: lastTradingDate, ...ohlcv }], { trustedOfficial: true });
                tpexInjected++;
                return 1;
              }
            }
          }

          // ── 全量 API 下載（L1 缺失、官方 bulk 無此股，或需覆寫同日非正式資料）──
          try {
            const candles = await scanner.fetchCandles(symbol);
            if (candles.length > 0) {
              await saveLocalCandles(symbol, market, candles);
              const fetchedTargetDate = candles.some((c) => c.date >= lastTradingDate);
              return fetchedTargetDate
                ? candles.length
                : { failed: true, reason: `provider-stale:${candles[candles.length - 1]?.date ?? 'unknown'}` };
            }
            // 拉到空陣列：所有 provider 都沒回 → 可能停牌或退市
            return { failed: true, reason: 'all-providers-empty' };
          } catch (err) {
            return { failed: true, reason: `fetch-error:${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}` };
          }
        })
      );

      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        if (r.status === 'fulfilled') {
          const v = r.value;
          if (typeof v === 'number') {
            if (v === -1) skipped++;
            else if (v > 0) succeeded++;
            else failed++;
          } else {
            // 失敗物件
            failed++;
            failedSymbols.push({ symbol: batch[j].symbol, reason: v.reason });
          }
        } else {
          failed++;
          failedSymbols.push({
            symbol: batch[j].symbol,
            reason: `rejected:${r.reason instanceof Error ? r.reason.message.slice(0, 80) : String(r.reason).slice(0, 80)}`,
          });
        }
      }

      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);

      // 進度 log（每 100 檔印一次）
      if ((i + CONCURRENCY) % 100 < CONCURRENCY) {
        console.info(`[download-candles] ${market}: ${i + CONCURRENCY}/${stocks.length} (ok=${succeeded}, skip=${skipped}, fail=${failed})`);
      }
    }

    // ── 大盤指數（^TWII / ^TWOII / 000001.SS）─ scanner.getStockList 不含指數，非 batch 路由也須補 ──
    // 否則 TW 在 Vercel 只跑非 batch download-candles，^TWII 永不更新（停在舊日）→ 下游
    // 大盤趨勢 / regime / tw-sanse 掃描 frontier 全部落後（個股到當日、指數落後 → 全檔被當殭屍
    // staleSkip）。對齊 download-candles-batch 的 proxy 指數下載。
    try {
      const indexSymbols = market === 'TW' ? ['^TWII', '^TWOII'] : ['000001.SS'];
      for (const indexSymbol of indexSymbols) {
        const idxExisting = await readCandleFile(indexSymbol, market);
        if (!idxExisting || idxExisting.lastDate < lastTradingDate) {
          const idxCandles = await scanner.fetchCandles(indexSymbol);
          if (idxCandles.length > 0) {
            await saveLocalCandles(indexSymbol, market, idxCandles);
            console.info(`[download-candles] ${market} 指數 ${indexSymbol}: ${idxCandles.length} 根已更新到 ${idxCandles[idxCandles.length - 1]?.date}`);
          } else {
            console.warn(`[download-candles] ${market} 指數 ${indexSymbol}: 無資料（來源回空）`);
          }
        }
      }
    } catch (err) {
      console.warn(`[download-candles] ${market} 指數下載失敗:`, err);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.info(
      `[download-candles] ${market}: 完成 — ${succeeded} API下載, ` +
      `${twseInjected} TWSE注入, ${tpexInjected} TPEx注入, ${l2Injected} L2注入, ${skipped} 跳過, ${failed} 失敗, ${duration}s`
    );

    // 保存下載清單（供掃描前檢查覆蓋率使用）
    await saveDownloadManifest(market, lastTradingDate, {
      total: stocks.length,
      succeeded,
      skipped,
      failed,
      coverage: Math.round((succeeded + skipped) / stocks.length * 100),
      durationSec: parseFloat(duration),
      failedSymbols: failedSymbols.length > 0 ? failedSymbols : undefined,
      stocklistSize: stocks.length,
    }).catch(err => console.warn('[download-candles] manifest save failed:', err));

    // 失敗 list 太長時印頭幾筆，方便排查
    if (failedSymbols.length > 0) {
      const preview = failedSymbols.slice(0, 10).map(f => `${f.symbol}(${f.reason.slice(0, 30)})`).join(', ');
      console.warn(`[download-candles] ${market}: ${failedSymbols.length} 支失敗，前 10：${preview}`);
    }

    // ── 生成 MA Base（供盤中粗掃即時 MA 計算用）──
    let maBaseResult = { total: 0, succeeded: 0, failed: 0 };
    try {
      const { generateMABase } = await import('@/lib/datasource/MABaseGenerator');
      maBaseResult = await generateMABase(market, lastTradingDate, stocks);
      console.info(`[download-candles] ${market}: MA Base 已生成 (${maBaseResult.succeeded}/${maBaseResult.total})`);
    } catch (err) {
      console.warn('[download-candles] MA Base generation failed:', err);
    }

    // ── 校驗下載結果（gap + lastDate + 覆蓋率報告）──
    let verifyResult: { health: string; coverageRate: number; stocksWithGaps: number; stocksStale: number } | undefined;
    try {
      const allSymbols = stocks.map(s => s.symbol);
      const report = await verifyDownload(market, lastTradingDate, allSymbols, { succeeded, failed, skipped });
      verifyResult = {
        health: report.health,
        coverageRate: report.summary.coverageRate,
        stocksWithGaps: report.summary.stocksWithGaps,
        stocksStale: report.summary.stocksStale,
      };
    } catch (err) {
      console.warn('[download-candles] verify failed:', err);
    }

    // ── 最終守護：TWSE MI_INDEX 全量交叉稽核 + 自動修復（TW 上市專用）──
    // 防止：L2 注入或 API 下載寫入集合競價前的錯誤收盤價
    // 機制：對所有有 TWSE 官方資料的 .TW 股票，比對 L1 vs 官方，偏差 > 0.5% 自動覆寫
    let twseAudit: { checked: number; repaired: number; samples: string[] } | undefined;
    if (market === 'TW' && twseMap) {
      let checked = 0, repaired = 0;
      const samples: string[] = [];
      for (const stock of stocks) {
        if (!stock.symbol.endsWith('.TW')) continue;
        const code = stock.symbol.replace(/\.TW$/i, '');
        const official = twseMap.get(code);
        if (!official) continue;

        const l1Data = await readCandleFile(stock.symbol, market);
        if (!l1Data || l1Data.lastDate !== lastTradingDate) continue;
        const lastBar = l1Data.candles[l1Data.candles.length - 1];
        if (!lastBar) continue;
        checked++;

        // 防呆：官方值若相對「前一日封存收盤」跳動 >50%（來源錯位），不可拿來覆寫 L1
        const prevBar = l1Data.candles[l1Data.candles.length - 2];
        if (suspectsGrossJump(prevBar?.close, official)) continue;

        const diffAbs = Math.abs(lastBar.close - official.close);
        const diffPct = diffAbs / official.close;
        if (diffAbs > 1 || diffPct > 0.005) {
          await saveLocalCandles(stock.symbol, market, [{ date: lastTradingDate, ...official }], { trustedOfficial: true });
          repaired++;
          if (samples.length < 5) {
            samples.push(`${stock.symbol}: L1=${lastBar.close} → TWSE=${official.close} (${(diffPct * 100).toFixed(2)}%)`);
          }
        }
      }
      twseAudit = { checked, repaired, samples };
      if (repaired > 0) {
        console.warn(
          `[download-candles] TW: ★ TWSE 交叉稽核修復 ${repaired}/${checked} 支偏差股票`
        );
        for (const s of samples) console.warn(`  ${s}`);
      } else {
        console.info(`[download-candles] TW: TWSE 交叉稽核通過 ${checked} 支全部一致`);
      }
    }

    // ── 最終守護：TPEx OpenAPI 全量交叉稽核 + 自動修復（TW 上櫃 .TWO 專用）──
    // 跟 twseAudit 平行：對所有有 TPEx 官方資料的 .TWO 股票，比對 L1 vs 官方，偏差 > 0.5% 自動覆寫
    let tpexAudit: { checked: number; repaired: number; samples: string[] } | undefined;
    if (market === 'TW' && tpexMap) {
      let checked = 0, repaired = 0;
      const samples: string[] = [];
      for (const stock of stocks) {
        if (!stock.symbol.endsWith('.TWO')) continue;
        const code = stock.symbol.replace(/\.TWO$/i, '');
        const official = tpexMap.get(code);
        if (!official) continue;

        const l1Data = await readCandleFile(stock.symbol, market);
        if (!l1Data || l1Data.lastDate !== lastTradingDate) continue;
        const lastBar = l1Data.candles[l1Data.candles.length - 1];
        if (!lastBar) continue;
        checked++;

        // 防呆：官方值若相對「前一日封存收盤」跳動 >50%（來源錯位），不可拿來覆寫 L1
        const prevBar = l1Data.candles[l1Data.candles.length - 2];
        if (suspectsGrossJump(prevBar?.close, official)) continue;

        const diffAbs = Math.abs(lastBar.close - official.close);
        const diffPct = diffAbs / official.close;
        if (diffAbs > 1 || diffPct > 0.005) {
          await saveLocalCandles(stock.symbol, market, [{ date: lastTradingDate, ...official }], { trustedOfficial: true });
          repaired++;
          if (samples.length < 5) {
            samples.push(`${stock.symbol}: L1=${lastBar.close} → TPEx=${official.close} (${(diffPct * 100).toFixed(2)}%)`);
          }
        }
      }
      tpexAudit = { checked, repaired, samples };
      if (repaired > 0) {
        console.warn(
          `[download-candles] TW: ★ TPEx 交叉稽核修復 ${repaired}/${checked} 支偏差上櫃股票`
        );
        for (const s of samples) console.warn(`  ${s}`);
      } else {
        console.info(`[download-candles] TW: TPEx 交叉稽核通過 ${checked} 支全部一致`);
      }
    }

    // ── L1 抽查（Yahoo 交叉核驗 — 第三道防線） ──
    let spotCheck: import('@/lib/datasource/L1SpotCheck').SpotCheckResult | undefined;
    try {
      const allSymbols = stocks.map(s => s.symbol);
      spotCheck = await spotCheckL1(market, lastTradingDate, allSymbols);
    } catch (err) {
      console.warn('[download-candles] L1 抽查失敗:', err);
    }

    return apiOk({
      market,
      totalStocks: stocks.length,
      succeeded,
      twseInjected,
      tpexInjected,
      l2Injected,
      skipped,
      failed,
      durationSec: parseFloat(duration),
      maBase: maBaseResult,
      verify: verifyResult,
      backfill: {
        filled: backfillFilled,
        failed: backfillFailed,
        skipped: backfillSkipped,
      },
      twseAudit,
      tpexAudit,
      spotCheck: spotCheck ? { passed: spotCheck.passed, failed: spotCheck.failed, suspicious: spotCheck.suspicious } : undefined,
    });
  } catch (err) {
    console.error(`[download-candles] ${market}: 錯誤`, err);
    return apiError(String(err));
  } finally {
    downloadInFlight.delete(market);
  }
}
