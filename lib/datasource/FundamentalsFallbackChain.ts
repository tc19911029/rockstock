/**
 * Fundamentals 多源 fallback chain
 *
 * 策略：FinMind 拿不到就立刻換源，永遠回最完整的可得資料。
 *
 * 來源優先順序：
 *   1. FinMind（getFundamentals）— 完整資料：EPS / EPS YoY / 毛利率 / 月營收 / PER / PBR / 殖利率
 *   2. TWSE BWIBBU 公開 API — 只有估值面：PER / PBR / 殖利率（無 EPS / 營收）
 *   3. TPEx OpenAPI（上櫃股 PER / PBR / 殖利率）
 *   4. TWSE OpenAPI t187ap14_L / t187ap05_L 補位 — EPS / 月營收 YoY / 淨利率
 *   5. 全 null（最後保底）
 *
 * 每源 timeout 5 秒，失敗就立刻換下一個。
 * 每次回傳會標明哪源命中（給 debug + 監控用）。
 */

import { getFundamentals, FundamentalsData } from './FinMindClient';
import { getQuarterlyAny, getMonthlyAny } from './TwseOpenApiProvider';

export type FundamentalsSource = 'finmind' | 'twse' | 'tpex' | 'twse_openapi' | 'none';

export interface FundamentalsWithSource extends FundamentalsData {
  /** 哪個源命中 */
  sourceUsed: FundamentalsSource;
  /** 各源的健康狀況（debug 用）*/
  sourceAttempts: Array<{
    source: FundamentalsSource;
    ok: boolean;
    error?: string;
    latencyMs: number;
  }>;
}

const SOURCE_TIMEOUT_MS = 5_000;

/**
 * 多源取 fundamentals，FinMind 失敗立刻換 TWSE / TPEx
 */
export async function getFundamentalsWithFallback(
  stockId: string,
): Promise<FundamentalsWithSource> {
  const attempts: FundamentalsWithSource['sourceAttempts'] = [];
  const bare = stockId.replace(/\.(TW|TWO)$/i, '');

  // ── 1. FinMind（主源）──
  // contract：FinMind 成功 → 不換源、不打外網（含 OpenAPI 補位）
  const finmindRes = await tryFinMind(bare);
  attempts.push(finmindRes.attempt);
  if (finmindRes.ok && hasUsefulData(finmindRes.data!)) {
    return {
      ...finmindRes.data!,
      sourceUsed: 'finmind',
      sourceAttempts: attempts,
    };
  }

  // ── 2. TWSE BWIBBU（PER / PBR / 殖利率）+ TWSE OpenAPI 補 EPS / 月營收 YoY ──
  const twseRes = await tryTWSE(bare);
  attempts.push(twseRes.attempt);
  if (twseRes.ok && hasUsefulData(twseRes.data!)) {
    const merged = mergeFundamentals(finmindRes.data, twseRes.data!);
    const openApi = await tryTwseOpenApi(bare);
    return {
      ...mergeFundamentals(merged, openApi),
      sourceUsed: 'twse',
      sourceAttempts: attempts,
    };
  }

  // ── 3. TPEx（上櫃，類似 endpoint）──
  const tpexRes = await tryTPEx(bare);
  attempts.push(tpexRes.attempt);
  if (tpexRes.ok && hasUsefulData(tpexRes.data!)) {
    const merged = mergeFundamentals(finmindRes.data, tpexRes.data!);
    // 嘗試從 TWSE OpenAPI 再補 EPS / 月營收 YoY / 淨利率
    const openApiData = await tryTwseOpenApi(bare);
    return {
      ...mergeFundamentals(merged, openApiData),
      sourceUsed: 'tpex',
      sourceAttempts: attempts,
    };
  }

  // ── 4. TWSE OpenAPI（補 EPS / 月營收 YoY / 淨利率，純 JSON 免處理）──
  const openApiData = await tryTwseOpenApi(bare);
  attempts.push({
    source: 'twse_openapi',
    ok: hasUsefulData(openApiData),
    latencyMs: 0,
  });
  if (hasUsefulData(openApiData)) {
    return {
      ...mergeFundamentals(finmindRes.data, openApiData),
      sourceUsed: 'twse_openapi',
      sourceAttempts: attempts,
    };
  }

  // ── 5. 最後保底：返回最完整可得（可能全 null）──
  return {
    ...(finmindRes.data ?? emptyFundamentals()),
    sourceUsed: 'none',
    sourceAttempts: attempts,
  };
}

/**
 * TWSE OpenAPI 補位：抓 t187ap14_L 季財報 + t187ap05_L 月營收，
 * 自動處理上市/上櫃（TPEx mopsfin_*_O）
 */
async function tryTwseOpenApi(stockId: string): Promise<FundamentalsData> {
  const [q, m] = await Promise.all([
    getQuarterlyAny(stockId),
    getMonthlyAny(stockId),
  ]);
  return {
    ...emptyFundamentals(),
    eps: q?.eps ?? null,
    netMargin: q?.netMargin ?? null,
    revenueLatest: m?.revenue ?? null,
    revenueYoY: m?.revenueYoY ?? null,
    revenueMoM: m?.revenueMoM ?? null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 各源實作
// ────────────────────────────────────────────────────────────────────────────

async function tryFinMind(stockId: string): Promise<{
  ok: boolean;
  data: FundamentalsData | null;
  attempt: FundamentalsWithSource['sourceAttempts'][0];
}> {
  const started = Date.now();
  try {
    const data = await withTimeout(getFundamentals(stockId), SOURCE_TIMEOUT_MS);
    return {
      ok: true,
      data,
      attempt: { source: 'finmind', ok: true, latencyMs: Date.now() - started },
    };
  } catch (err) {
    return {
      ok: false,
      data: null,
      attempt: {
        source: 'finmind', ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      },
    };
  }
}

async function tryTWSE(stockId: string): Promise<{
  ok: boolean;
  data: FundamentalsData | null;
  attempt: FundamentalsWithSource['sourceAttempts'][0];
}> {
  const started = Date.now();
  try {
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU?date=&stockNo=${encodeURIComponent(stockId)}&response=json`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      // 2026-05-22：同 finmindFetch，避免 Next.js fetch cache 卡 stale
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      stat?: string;
      fields?: string[];
      data?: Array<Array<string | number>>;
    };
    // TWSE 即使 stat 為 warning（例如「查詢日期超過可查詢區間」），data 仍會回最近可用歷史
    // 只有 data 真正空才視為失敗
    if (!Array.isArray(json.data) || json.data.length === 0) {
      throw new Error(`TWSE stat=${json.stat}, rows=${json.data?.length ?? 0}`);
    }
    // 取最新一筆 [日期, 殖利率%, 股利年度, 本益比, 股價淨值比, 財報年/季]
    const latest = json.data[json.data.length - 1];
    const data: FundamentalsData = {
      ...emptyFundamentals(),
      dividendYield: toNum(latest[1]),
      per: toNum(latest[3]),
      pbr: toNum(latest[4]),
    };
    return {
      ok: true, data,
      attempt: { source: 'twse', ok: true, latencyMs: Date.now() - started },
    };
  } catch (err) {
    return {
      ok: false, data: null,
      attempt: {
        source: 'twse', ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      },
    };
  }
}

async function tryTPEx(stockId: string): Promise<{
  ok: boolean;
  data: FundamentalsData | null;
  attempt: FundamentalsWithSource['sourceAttempts'][0];
}> {
  const started = Date.now();
  try {
    // 官方 OpenAPI 單次回傳全部上櫃股票；依代號挑該檔。不能把 N/A 轉成 0，
    // 否則負 EPS 股票會被誤判成極低本益比。
    const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis';
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      cache: 'no-store',
      headers: { 'User-Agent': 'Rockstock/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json() as Array<{
      SecuritiesCompanyCode?: string;
      PriceEarningRatio?: string | number;
      YieldRatio?: string | number;
      PriceBookRatio?: string | number;
    }>;
    const row = Array.isArray(rows)
      ? rows.find((item) => String(item.SecuritiesCompanyCode ?? '').trim() === stockId)
      : undefined;
    if (!row) throw new Error(`TPEx 找不到 ${stockId}`);
    const data: FundamentalsData = {
      ...emptyFundamentals(),
      per: toNum(row.PriceEarningRatio),
      pbr: toNum(row.PriceBookRatio),
      dividendYield: toNum(row.YieldRatio),
    };
    if (!hasUsefulData(data)) throw new Error(`TPEx ${stockId} 無可用估值欄位`);
    return {
      ok: true,
      data,
      attempt: { source: 'tpex', ok: true, latencyMs: Date.now() - started },
    };
  } catch (err) {
    return {
      ok: false, data: null,
      attempt: {
        source: 'tpex', ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      },
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

function emptyFundamentals(): FundamentalsData {
  return {
    eps: null, epsYoY: null,
    grossMargin: null, netMargin: null,
    per: null, pbr: null, dividendYield: null,
    revenueLatest: null, revenueMoM: null, revenueYoY: null,
  };
}

function hasUsefulData(d: FundamentalsData): boolean {
  return (
    d.eps != null ||
    d.per != null ||
    d.pbr != null ||
    d.revenueLatest != null
  );
}

/** 合併兩個 FundamentalsData，後者填補前者 null 的欄位 */
function mergeFundamentals(
  primary: FundamentalsData | null,
  fallback: FundamentalsData,
): FundamentalsData {
  if (!primary) return fallback;
  return {
    eps:            primary.eps           ?? fallback.eps,
    epsYoY:         primary.epsYoY        ?? fallback.epsYoY,
    grossMargin:    primary.grossMargin   ?? fallback.grossMargin,
    netMargin:      primary.netMargin     ?? fallback.netMargin,
    per:            primary.per           ?? fallback.per,
    pbr:            primary.pbr           ?? fallback.pbr,
    dividendYield:  primary.dividendYield ?? fallback.dividendYield,
    revenueLatest:  primary.revenueLatest ?? fallback.revenueLatest,
    revenueMoM:     primary.revenueMoM    ?? fallback.revenueMoM,
    revenueYoY:     primary.revenueYoY    ?? fallback.revenueYoY,
    periods:        primary.periods       ?? fallback.periods,
  };
}

function toNum(v: string | number | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = v.replace(/[,\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === 'N/A') return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}
