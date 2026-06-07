/**
 * Daily cron：累積主力券商分點快照 → data/chips/TW/broker/{code}.json
 *
 * Yahoo broker-trading 只有「當日」快照、無歷史；本 cron 每日盤後（券商分點 17:00 後公布）
 * 對「已被關注的股票」（已有 inst/broker cache）逐檔抓一次並 append，讓
 * lib/chipcost/brokerCost 能逐步累積出「主力成本均線」。歷史 < 20 日前標示「累積中」。
 *
 * 純顯示資料流，不進選股 gate（鐵則 #5）。
 *
 * 用法：
 *   /api/cron/snapshot-broker-tw                  # 預設宇宙（inst ∪ broker cache，cap limit）
 *   /api/cron/snapshot-broker-tw?codes=3661,2330  # 指定清單
 *   /api/cron/snapshot-broker-tw?limit=300        # 調整上限
 */
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { apiOk } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { fetchYahooBrokerTrades } from '@/lib/datasource/YahooBrokerScraper';
import { appendBrokerDay } from '@/lib/chips/BrokerStorage';

export const runtime = 'nodejs';
export const maxDuration = 300;

const INST_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'inst');
const BROKER_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'broker');
const DEFAULT_LIMIT = 250;
const CONCURRENCY = 6;

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
  if (codesParam) {
    codes = codesParam.split(',').map(c => c.replace(/\.(TW|TWO)$/i, '').trim()).filter(Boolean);
  } else {
    const [brokerCodes, instCodes] = await Promise.all([listCodes(BROKER_DIR), listCodes(INST_DIR)]);
    codes = Array.from(new Set([...brokerCodes, ...instCodes])).slice(0, limit);
  }

  if (codes.length === 0) {
    return apiOk({ skipped: true, reason: 'no codes (no inst/broker cache yet; pass ?codes=)', date });
  }

  let written = 0;
  let missed = 0;
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const chunk = codes.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async code => {
      try {
        const t = await fetchYahooBrokerTrades(code);
        if (!t) { missed++; return; }
        const d = /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : date;
        await appendBrokerDay(code, d, {
          netDifference: t.totalDifferenceVolK,
          concentration: +(t.concentration * 100).toFixed(2),
        });
        written++;
      } catch {
        missed++;
      }
    }));
  }

  return apiOk({ date, requested: codes.length, written, missed });
}
