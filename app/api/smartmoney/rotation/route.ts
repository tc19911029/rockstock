import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api/response';
import { fetchYahooBrokerTrades } from '@/lib/datasource/YahooBrokerScraper';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { rotationPointFromYahoo, type SmartMoneyRotationPoint } from '@/lib/smartmoney/rotation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_CODES = ['5475', '8046', '6187', '2467', '6584', '4576', '3044', '2408'];
const MAX_CODES = 20;
const CONCURRENCY = 5;

let nameMapPromise: Promise<Map<string, string>> | null = null;

async function readNameMap(): Promise<Map<string, string>> {
  if (!nameMapPromise) {
    nameMapPromise = fs.readFile(
      path.join(process.cwd(), 'data', 'youtube', 'stock-master.json'),
      'utf8',
    ).then((raw) => {
      const parsed = JSON.parse(raw) as { entries?: Array<{ code?: string; name?: string }> };
      return new Map(
        (parsed.entries ?? [])
          .filter((entry): entry is { code: string; name: string } => !!entry.code && !!entry.name)
          .map((entry) => [entry.code, entry.name.trim()]),
      );
    }).catch(() => new Map<string, string>());
  }
  return nameMapPromise;
}
function parseCodes(raw: string | null): string[] | null {
  if (!raw?.trim()) return DEFAULT_CODES;
  const codes = Array.from(new Set(
    raw
      .split(/[\s,，、]+/)
      .map((value) => value.trim().toUpperCase().replace(/\.(TW|TWO)$/i, ''))
      .filter(Boolean),
  ));
  if (codes.length === 0 || codes.length > MAX_CODES) return null;
  if (codes.some((code) => !/^\d{4,5}$/.test(code))) return null;
  return codes;
}

async function fallbackVolume(code: string, date: string): Promise<number | null> {
  for (const suffix of ['TW', 'TWO'] as const) {
    const file = await readCandleFile(`${code}.${suffix}`, 'TW').catch(() => null);
    const candle = file?.candles.find((row) => row.date === date);
    if (candle?.volume && candle.volume > 0) return candle.volume;
  }
  return null;
}

async function buildPoint(code: string, nameMap: Map<string, string>): Promise<SmartMoneyRotationPoint | null> {
  const trades = await fetchYahooBrokerTrades(code);
  if (!trades) return null;
  const volume = await fallbackVolume(code, trades.date);
  return rotationPointFromYahoo({
    code,
    name: nameMap.get(code) ?? null,
    trades,
    fallbackTotalVolume: volume,
  });
}

export async function GET(req: NextRequest) {
  const codes = parseCodes(req.nextUrl.searchParams.get('codes'));
  if (!codes) return apiError(`請輸入 1–${MAX_CODES} 個有效台股代號`, 400);

  try {
    const nameMap = await readNameMap();
    const points: SmartMoneyRotationPoint[] = [];
    const missing: string[] = [];

    for (let index = 0; index < codes.length; index += CONCURRENCY) {
      const batch = codes.slice(index, index + CONCURRENCY);
      const settled = await Promise.allSettled(batch.map((code) => buildPoint(code, nameMap)));
      settled.forEach((result, offset) => {
        const code = batch[offset];
        if (result.status === 'fulfilled' && result.value) points.push(result.value);
        else missing.push(code);
      });
    }

    points.sort((a, b) =>
      b.largeDiffRatio - a.largeDiffRatio || b.largeTradeRatio - a.largeTradeRatio,
    );
    const dates = Array.from(new Set(points.map((point) => point.date))).sort();

    return apiOk({
      points,
      requestedCodes: codes,
      missingCodes: missing,
      dates,
      thresholds: { largeTradeRatio: 70, largeDiffRatio: 20 },
      source: 'Yahoo 前15大買方／賣方分點張數近似',
      caveat: '非 XQ 逐筆大單／特大單成交金額，不可視為 XQ 原值',
    });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '大戶輪動資料載入失敗', 500);
  }
}
