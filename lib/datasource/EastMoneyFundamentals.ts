/**
 * EastMoneyFundamentals.ts — 東方財富陸股估值欄位
 *
 * 從東方財富 push2 個股詳情 API 取得估值欄位（最新價 / 估值 / 每股數據），
 * 並用逐季財報（RPT_LICO_FN_CPD 累計歸母淨利）+ 總市值「自算」靜態 / TTM 本益比。
 *
 * Endpoint：
 *   https://push2.eastmoney.com/api/qt/stock/get?secid={market}.{code}&fields=...
 *   （push2 會 302 轉 push2delay.eastmoney.com；Node fetch 預設跟轉址。）
 *
 * 現行欄位代碼（2026-05 對茅台/五粮液/平安/比亞迪四檔交叉驗證）：
 *   f43  = 最新價（×100）
 *   f55  = 每股收益 EPS（最新一季，原值）— 已改用財報自算單季 EPS 為主、f55 僅備援（見下）
 *   f57  = 代碼
 *   f58  = 名稱
 *   f84  = 總股本（股）
 *   f85  = 流通股本（股）
 *   f92  = 每股淨資產（原值）
 *   f105 = 歸母淨利（本期累計，元）
 *   f116 = 總市值（元）
 *   f117 = 流通市值（元）
 *   f162 = 市盈率（動，×100）＝ 年化最新季
 *   f167 = 市淨率 PB（×100）
 *   f173 = 加權 ROE %（最新一季，原值）
 *
 * ⚠️ 已棄用的漂移死碼：f108/f112/f114/f115（回 0）、f161（市盈率欄已漂成亂數，茅台回 330、五粮液回 2434）、
 *    f163/f164（茅台/平安對得上靜/TTM，但五粮液對不上 → 不可信）。
 *    靜態 / TTM 本益比一律改「自算」：總市值 ÷ 年度（或滾動四季）歸母淨利。
 *
 * 2026-05-31：latestQuarterEps 也改「自算」單季 EPS = 單季歸母淨利 ÷ 總股本，
 *    與自算 PE 同源（市值÷淨利 ≡ 價格÷(淨利/股本)）。push2 f55 在被限流時會回 degraded
 *    stub（實測連打多檔全回 18.6），自算可避開；財報抓不到才回退 f55。display-only，
 *    不進選股/評分（那走財報 RPT_LICO netProfitYoY）。
 */

import { globalCache } from './MemoryCache';
import { fetchCnFinancials } from './EastMoneyFinancials';

const FUNDAMENTALS_TTL = 30 * 60 * 1000; // 30 分鐘

export interface EastMoneyFundamentals {
  code: string;
  name: string | null;
  price: number | null;
  latestQuarterEps: number | null;   // 收益（一）＝最新一季 EPS
  bookValuePerShare: number | null;  // 每股淨資產
  pbRatio: number | null;            // 市淨率 PB
  dynamicPe: number | null;          // 市盈率（動）＝年化最新季
  staticPe: number | null;           // 市盈率（靜）＝總市值 ÷ 上年度全年歸母淨利（自算）
  ttmPe: number | null;              // 市盈率（TTM）＝總市值 ÷ 滾動四季歸母淨利（自算）
  roe: number | null;                // 加權 ROE %（最新一季）
  totalShares: number | null;        // 總股本（股）
  floatShares: number | null;        // 流通股本（股）
  totalMarketCap: number | null;     // 總市值（元）
  floatMarketCap: number | null;     // 流通市值（元）
  netIncome: number | null;          // 歸母淨利（本期累計，元）
  equity: number | null;             // 淨資產（元，由每股淨資產×總股本推算）
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
 * 用逐季財報（累計歸母淨利，元）+ 總市值「自算」靜態 / TTM 本益比。
 *
 *   靜態 PE = 總市值 ÷ 最近一個完整年度（12-31）的全年歸母淨利
 *   TTM PE  = 總市值 ÷ 滾動四季歸母淨利
 *             ＝ 上一完整年度全年 − 去年同期累計 + 最近一期累計
 *
 * 財報抓不到或缺淨利 → 回 null（不拋）。
 */
async function computeStaticTtmPe(
  bareCode: string,
  totalMarketCap: number | null,
  totalShares: number | null,
): Promise<{ staticPe: number | null; ttmPe: number | null; latestQuarterEps: number | null }> {
  if (totalMarketCap == null || totalMarketCap <= 0) return { staticPe: null, ttmPe: null, latestQuarterEps: null };

  let fins;
  try {
    fins = await fetchCnFinancials(bareCode, 8);
  } catch {
    return { staticPe: null, ttmPe: null, latestQuarterEps: null };
  }
  // netProfit 是累計 YTD（元）；fetchCnFinancials 已排序新→舊。
  const withNet = fins.filter((f) => f.netProfit != null && /^\d{4}-\d{2}-\d{2}$/.test(f.reportDate));
  if (withNet.length === 0) return { staticPe: null, ttmPe: null, latestQuarterEps: null };

  // 最近一個完整年度（12-31）的全年歸母淨利 → 靜態 PE
  const lastAnnual = withNet.find((f) => f.reportDate.endsWith('-12-31'));
  const staticPe =
    lastAnnual && lastAnnual.netProfit != null && lastAnnual.netProfit > 0
      ? totalMarketCap / lastAnnual.netProfit
      : null;

  // TTM 歸母淨利（滾動四季）
  const latest = withNet[0];
  let ttmNet: number | null = null;
  if (latest.reportDate.endsWith('-12-31')) {
    ttmNet = latest.netProfit; // 年報本身即 TTM
  } else if (lastAnnual && lastAnnual.netProfit != null && latest.netProfit != null) {
    const yr = parseInt(latest.reportDate.slice(0, 4), 10);
    const mmdd = latest.reportDate.slice(4); // 例 '-03-31'
    const prevSame = withNet.find((f) => f.reportDate === `${yr - 1}${mmdd}`);
    if (prevSame && prevSame.netProfit != null) {
      ttmNet = lastAnnual.netProfit - prevSame.netProfit + latest.netProfit;
    }
  }
  const ttmPe = ttmNet != null && ttmNet > 0 ? totalMarketCap / ttmNet : null;

  // 自算單季 EPS = 單季歸母淨利 ÷ 總股本
  // 單季淨利 = 最近一期累計 − 同年上一期累計（Q1 累計本身即單季）。
  // 取不到上一期（剛上市/缺報）→ 用累計值近似（至少不會是 push2 degraded stub）。
  let latestQuarterEps: number | null = null;
  if (totalShares != null && totalShares > 0 && latest.netProfit != null) {
    const mm = latest.reportDate.slice(5, 7); // '03'|'06'|'09'|'12'
    let quarterNet: number | null = latest.netProfit; // Q1 或無前期 → 累計即單季
    if (mm !== '03') {
      // 找同年「上一個報告期」的累計值（06←03、09←06、12←09）
      const yr = latest.reportDate.slice(0, 4);
      const prevMmdd = mm === '06' ? '-03-31' : mm === '09' ? '-06-30' : '-09-30';
      const prevCum = withNet.find((f) => f.reportDate === `${yr}${prevMmdd}`);
      if (prevCum && prevCum.netProfit != null) quarterNet = latest.netProfit - prevCum.netProfit;
    }
    if (quarterNet != null) latestQuarterEps = +(quarterNet / totalShares).toFixed(4);
  }

  return { staticPe, ttmPe, latestQuarterEps };
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
  const bare = stockId.replace(/\.(SS|SZ)$/i, '');

  const fields = [
    'f43',  // 最新價（×100）
    'f55',  // 每股收益 EPS（最新一季）
    'f57',  // 代碼
    'f58',  // 名稱
    'f84',  // 總股本
    'f85',  // 流通股本
    'f92',  // 每股淨資產
    'f105', // 歸母淨利（本期累計）
    'f116', // 總市值
    'f117', // 流通市值
    'f162', // 市盈率（動，×100）
    'f167', // 市淨率（×100）
    'f173', // 加權 ROE %
  ].join(',');

  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}&_=${Date.now()}`;

  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://quote.eastmoney.com/',
      },
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

    const price = num('f43', 100);
    const eps = num('f55');                 // 每股收益原值（元）
    const dyn = num('f162', 100);           // 市盈率（動）
    const pb = num('f167', 100);            // 市淨率
    const bvps = num('f92');                // 每股淨資產原值
    const roe = num('f173');                // ROE %
    const totalShares = num('f84');
    const floatShares = num('f85');
    const totalMarketCap = num('f116');
    const floatMarketCap = num('f117');
    const netIncome = num('f105');

    // 靜態 / TTM PE + 單季 EPS 自算（push2 的 PE/EPS 欄會漂/被限流回 stub，不可信）
    const { staticPe, ttmPe, latestQuarterEps: computedEps } =
      await computeStaticTtmPe(bare, totalMarketCap, totalShares);
    // 自算優先；財報抓不到（computedEps=null）才回退 push2 f55
    const latestQuarterEps = computedEps ?? eps;

    const result: EastMoneyFundamentals = {
      code: typeof d['f57'] === 'string' ? d['f57'] as string : stockId,
      name: typeof d['f58'] === 'string' ? d['f58'] as string : null,
      price,
      latestQuarterEps,
      bookValuePerShare: bvps,
      pbRatio: pb,
      dynamicPe: dyn,
      staticPe,
      ttmPe,
      roe,
      totalShares,
      floatShares,
      totalMarketCap,
      floatMarketCap,
      netIncome,
      equity: bvps != null && totalShares != null ? bvps * totalShares : null,
      sourceUrl: `https://quote.eastmoney.com/${secid.startsWith('1') ? 'sh' : 'sz'}${bare}.html`,
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
