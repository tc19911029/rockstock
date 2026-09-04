/**
 * Daily cron：累積主力券商分點快照 → data/chips/TW/broker/{code}.json
 *
 * Yahoo broker-trading 只有「當日」快照、無歷史；本 cron 每日盤後（券商分點 17:00 後公布）
 * 逐檔抓一次並 append，讓 lib/chipcost/brokerCost 累積「主力成本均線」、且讓 W/Y 軌
 * （大戶偷買 / 法人偷買）每日都有新鮮主力分點可掃。歷史 < 20 日前標示「累積中」。
 *
 * 純顯示資料流，不進選股 gate（鐵則 #5）。
 *
 * 宇宙：預設＝成交額前 800 緩衝池（Y/X 軌使用前 500，新進股票先累積歷史）。
 * 舊版用 `slice(0,250)` 取「代號最小 250 檔」（00403A~1907，全是 ETF＋1字頭），熱門股與
 * 整個成交額前 500 幾乎都不在名單裡 → 主力分點卡好幾天不更新 → Y軌（法人偷買）最近掃出 0。
 * 改讀 turnover-rank 索引根治；索引缺/壞 → fallback 舊的 inst∪broker cache slice。
 *
 * 用法：
 *   /api/cron/snapshot-broker-tw                  # 預設宇宙＝成交額前 800 緩衝池
 *   /api/cron/snapshot-broker-tw?codes=3661,2330  # 指定清單
 *   /api/cron/snapshot-broker-tw?limit=300        # 調整上限
 */
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { apiOk, apiFailure } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { fetchYahooBrokerTrades } from '@/lib/datasource/YahooBrokerScraper';
import { appendBrokerDay } from '@/lib/chips/BrokerStorage';
import { readTurnoverRank } from '@/lib/scanner/TurnoverRank';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { Y_TRACK_WARMING_TOP_N } from '@/lib/chips/yTrackReadiness';

export const runtime = 'nodejs';
export const maxDuration = 300;

const INST_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'inst');
const BROKER_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'broker');
// 抓大於策略前500的緩衝池，讓新進前500股票已累積足夠的10/20日歷史。
const DEFAULT_LIMIT = Y_TRACK_WARMING_TOP_N;
const CONCURRENCY = 6;
const MIN_COVERAGE = 0.98;

async function listCodes(dir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? getLastTradingDay('TW');
  if (!isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  const codesParam = req.nextUrl.searchParams.get('codes');
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT;

  let codes: string[];
  let universe: string;
  if (codesParam) {
    codes = codesParam.split(',').map(c => c.replace(/\.(TW|TWO)$/i, '').trim()).filter(Boolean);
    universe = 'param';
  } else {
    // 預設＝成交額前 500（與 Y/X 軌掃描池子同一份索引）→ 被掃的股票每日都有新鮮主力分點
    const rank = await readTurnoverRank('TW');
    if (rank && rank.symbols.size > 0) {
      let rankedSymbols = Array.from(rank.symbols);
      if (limit > rankedSymbols.length) {
        const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
        const { computeTurnoverRankAsOfDate } = await import('@/lib/scanner/TurnoverRank');
        const all = await new TaiwanScanner().getStockList();
        rankedSymbols = Array.from((await computeTurnoverRankAsOfDate('TW', all, date, limit)).keys());
      }
      // 停牌／當日無成交不算缺漏，也不浪費 Yahoo 請求。
      const traded = await Promise.all(rankedSymbols.slice(0, limit).map(async symbol => {
        const file = await readCandleFile(symbol, 'TW').catch(() => null);
        return file?.candles.some(candle => candle.date === date) ? symbol : null;
      }));
      codes = traded
        .filter((symbol): symbol is string => !!symbol)
        .map(symbol => symbol.replace(/\.(TW|TWO)$/i, '').trim());
      universe = `turnover-top${limit}-traded@${date}`;
    } else {
      // fallback：索引缺/壞 → 舊行為（inst∪broker cache）
      const [brokerCodes, instCodes] = await Promise.all([listCodes(BROKER_DIR), listCodes(INST_DIR)]);
      codes = Array.from(new Set([...brokerCodes, ...instCodes])).slice(0, limit);
      universe = 'cache-fallback';
    }
  }

  if (codes.length === 0) {
    return apiOk({ skipped: true, reason: 'no codes (no inst/broker cache yet; pass ?codes=)', date });
  }

  let written = 0;
  let missed = 0;
  let stale = 0;
  let pending = Array.from(new Set(codes));
  for (let attempt = 1; attempt <= 2 && pending.length > 0; attempt++) {
    const failed: string[] = [];
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const chunk = pending.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async code => {
      try {
        const t = await fetchYahooBrokerTrades(code);
        if (!t) { failed.push(code); return; }
        if (t.date !== date) { stale++; return; }
        await appendBrokerDay(code, date, {
          netDifference: t.totalDifferenceVolK,
          concentration: +(t.concentration * 100).toFixed(2),
        });
        written++;
      } catch {
        failed.push(code);
      }
      }));
    }
    pending = failed;
  }
  missed = pending.length;

  // Yahoo 回傳別的日期只能標成 stale，不能假裝今天已有資料。
  const coverage = codes.length > 0 ? +(written / codes.length).toFixed(4) : 0;
  const details = { date, universe, requested: codes.length, written, stale, missed, coverage };
  if (coverage < MIN_COVERAGE || missed > 0 || stale > 0) {
    return apiFailure('broker snapshot incomplete after retry', { dataStatus: 'degraded', ...details });
  }
  return apiOk({ dataStatus: 'complete', ...details });
}
