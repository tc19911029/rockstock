/**
 * EastMoneyFundamentals.ts — 東方財富陸股估值欄位
 *
 * 從東方財富 push2 個股詳情 API 取得估值欄位：
 *   - 收益（一）= 最新一季 EPS
 *   - 市盈率（動）/（靜）/（TTM）
 *   - 每股淨資產 / 市淨率
 *   - 總股本 / 流通股本
 *
 * Endpoint：
 *   https://push2.eastmoney.com/api/qt/stock/get?secid={market}.{code}&fields=...
 *
 * 主要欄位（東方財富代碼）：
 *   f43  = 最新價
 *   f57  = 代碼
 *   f58  = 名稱
 *   f84  = 總股本（單位：股）
 *   f85  = 流通股本（單位：股）
 *   f105 = 淨利潤
 *   f106 = 淨資產
 *   f108 = 市淨率 PB
 *   f112 = 每股收益 EPS（最新一季）
 *   f113 = 每股淨資產
 *   f114 = 市盈率（動）
 *   f115 = 市盈率（靜）
 *   f161 = 市盈率（TTM）
 *
 * 注意：實際欄位代碼可能因 EastMoney 改版而變動；本 provider 用 fields= 列舉，
 *       缺失欄位回 null（不拋）。
 */

import { globalCache } from './MemoryCache';

const FUNDAMENTALS_TTL = 30 * 60 * 1000; // 30 分鐘

export interface EastMoneyFundamentals {
  code: string;
  name: string | null;
  price: number | null;
  latestQuarterEps: number | null;   // 收益（一）
  bookValuePerShare: number | null;  // 每股淨資產
  pbRatio: number | null;            // 市淨率
  dynamicPe: number | null;          // 市盈率（動）
  staticPe: number | null;           // 市盈率（靜）
  ttmPe: number | null;              // 市盈率（TTM）
  totalShares: number | null;        // 總股本（股）
  floatShares: number | null;        // 流通股本（股）
  netIncome: number | null;          // 淨利潤
  equity: number | null;             // 淨資產
  sourceUrl: string;
  fetchedAt: string;
}

/**
 * 判斷市場（滬 = 1，深 = 0）
 */
function detectSecid(stockId: string): string | null {
  const bare = stockId.replace(/\.(SS|SZ)$/i, '');
  if (!/^\d{6}$/.test(bare)) return null;
  // 滬 A：60xxxx、688xxx（科創板）
  // 深 A：000xxx、001xxx、002xxx、003xxx、300xxx（創業板）
  if (/^(6|9)/.test(bare)) return `1.${bare}`;
  if (/^(0|1|2|3)/.test(bare)) return `0.${bare}`;
  return null;
}

/**
 * 取得陸股估值欄位。
 * 失敗回 null，由 caller 寫 fetchErrors。
 */
export async function getEastMoneyFundamentals(stockId: string): Promise<EastMoneyFundamentals | null> {
  const cacheKey = `emFundamentals:${stockId}`;
  const cached = globalCache.get<EastMoneyFundamentals>(cacheKey);
  if (cached) return cached;

  const secid = detectSecid(stockId);
  if (!secid) return null;

  const fields = [
    'f43',  // 最新價
    'f57',  // 代碼
    'f58',  // 名稱
    'f84',  // 總股本
    'f85',  // 流通股本
    'f105', // 淨利潤
    'f106', // 淨資產
    'f108', // 市淨率
    'f112', // 每股收益
    'f113', // 每股淨資產
    'f114', // 市盈率動
    'f115', // 市盈率靜
    'f161', // 市盈率 TTM（部分版本）
    'f167', // 市淨率（備用）
  ].join(',');

  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}&_=${Date.now()}`;

  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const json = await r.json() as { data?: Record<string, unknown> };
    const d = json.data;
    if (!d || typeof d !== 'object') return null;

    const num = (k: string, divisor = 1): number | null => {
      const v = d[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      return v / divisor;
    };

    // 東方財富 PE/PB 通常乘 100，price 通常乘 100
    const price = num('f43', 100);
    const eps = num('f112', 10000);       // 每股收益單位通常是 「分」乘以 10000 → 變成元
    const dyn = num('f114', 100);
    const stat = num('f115', 100);
    const ttm = num('f161', 100);
    const pb = num('f108', 100) ?? num('f167', 100);
    const bvps = num('f113', 10000);

    // 股本單位通常是「股」直接傳
    const totalShares = num('f84');
    const floatShares = num('f85');

    const result: EastMoneyFundamentals = {
      code: typeof d['f57'] === 'string' ? d['f57'] as string : stockId,
      name: typeof d['f58'] === 'string' ? d['f58'] as string : null,
      price,
      latestQuarterEps: eps,
      bookValuePerShare: bvps,
      pbRatio: pb,
      dynamicPe: dyn,
      staticPe: stat,
      ttmPe: ttm,
      totalShares,
      floatShares,
      netIncome: num('f105'),
      equity: num('f106'),
      sourceUrl: `https://quote.eastmoney.com/${secid.startsWith('1') ? 'sh' : 'sz'}${stockId.replace(/\.(SS|SZ)$/i, '')}.html`,
      fetchedAt: new Date().toISOString(),
    };

    if (result.price != null || result.latestQuarterEps != null) {
      globalCache.set(cacheKey, result, FUNDAMENTALS_TTL);
    }
    return result;
  } catch {
    return null;
  }
}
