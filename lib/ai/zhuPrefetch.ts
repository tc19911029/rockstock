/**
 * 朱老師問答的伺服器端 prefetch — 把容易拿到的所有資料先撈完打包進 question.json
 *
 * 朱老師打開問題檔就看完整桌面，不用一條一條 Bash 自己查。
 * 拿不到的（法說會、產業 narrative、美債/匯率）保持讓朱老師上網查。
 *
 * 拉的資料（8 條平行 fetch）：
 *   - 法人三大買賣超 /api/institutional/<symbol>
 *   - 綜合籌碼 /api/chip?symbol=...
 *   - 鎖股觀察 /api/lockwatch?market=...
 *   - 持有此股的主動 ETF（從 data/etf/snapshots/ grep）
 *   - 同產業近期掃描結果（從 /api/scanner/results 取同產業前幾名）
 *   - 基本面數字 /api/fundamentals/<symbol> （EPS、營收、毛利率、PER、PBR、殖利率）
 *   - 大盤趨勢 /api/scanner/market-trend?market=...&date=...
 *   - RSS 新聞聚合 /api/news/<symbol>
 *
 * 再用純規則算 suggestedLights / suggestedGrade，朱老師預設沿用、衝突時可覆寫。
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { computeChartLights, computeGrade } from './zhuLights';
import type { ChartLightsInput, Grade, ZhuLights } from './zhuTypes';

const SELF_BASE = process.env.NEXT_INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const FETCH_TIMEOUT_MS = 4_000;

export interface ZhuFundamentalsLite {
  eps: number | null;
  epsYoY: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  revenueLatest: number | null;
  revenueMoM: number | null;
  revenueYoY: number | null;
}

export interface ZhuMarketTrendLite {
  market: 'TW' | 'CN';
  date: string | null;
  trend: '多頭' | '空頭' | '盤整' | string;
}

export interface ZhuNewsLite {
  fetchedAt: string;
  hasNews: boolean;
  aggregateSentiment: number;
  summary: string;
  /** 最近 7 天前 5 條（title / source / publishedAt / label / score） */
  recent: Array<{
    title: string;
    source: string;
    publishedAt: string;
    label: 'positive' | 'negative' | 'neutral';
    score: number;
  }>;
}

export interface ZhuPrefetchData {
  institutional?: unknown;            // 法人三大買賣超
  chip?: unknown;                     // 綜合籌碼
  lockwatch?: unknown;                // 鎖股觀察狀態
  etfHoldings?: Array<{               // 哪些主動 ETF 持有它
    etf: string;
    snapshotDate: string;
    weight?: number;
    shares?: number;
  }>;
  sectorPeers?: unknown;              // 同產業近期表現
  fundamentals?: ZhuFundamentalsLite | null;
  marketTrend?: ZhuMarketTrendLite | null;
  news?: ZhuNewsLite | null;
  /** 純規則算出的 5 燈號建議（朱老師預設沿用、可覆寫） */
  suggestedLights?: ZhuLights;
  /** 純規則算出的 ABCDE 等級建議 */
  suggestedGrade?: Grade;
  fetchErrors?: string[];             // 哪些 prefetch 失敗，讓朱老師知道要 fallback
}

async function fetchJSON(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchInstitutional(symbol: string): Promise<unknown> {
  return fetchJSON(`${SELF_BASE}/api/institutional/${encodeURIComponent(symbol)}`);
}

async function fetchChip(symbol: string): Promise<unknown> {
  return fetchJSON(`${SELF_BASE}/api/chip?symbol=${encodeURIComponent(symbol)}`);
}

async function fetchLockwatch(market: 'TW' | 'CN', symbol: string): Promise<unknown> {
  const data = await fetchJSON(`${SELF_BASE}/api/lockwatch?market=${market}`);
  if (!data || typeof data !== 'object') return null;
  const list = (data as { entries?: Array<{ symbol?: string }> }).entries ?? [];
  return list.find(e => e.symbol === symbol || e.symbol === `${symbol}.TW` || e.symbol === `${symbol}.TWO`) ?? null;
}

/** 找哪些主動 ETF 最近的 snapshot 含這檔股票 */
async function findETFHoldings(symbol: string): Promise<ZhuPrefetchData['etfHoldings']> {
  try {
    const snapshotsDir = path.join(process.cwd(), 'data/etf/snapshots');
    const files = await readdir(snapshotsDir).catch(() => [] as string[]);
    // 只看最新的每個 ETF（檔名 etf-snap-<code>-<date>.json）
    const latestByETF = new Map<string, string>();
    for (const f of files) {
      const m = f.match(/^etf-snap-([^-]+)-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const [, etf, date] = m;
      const cur = latestByETF.get(etf);
      if (!cur || date > cur) latestByETF.set(etf, f);
    }
    const holdings: ZhuPrefetchData['etfHoldings'] = [];
    for (const [etf, file] of latestByETF) {
      try {
        const raw = await readFile(path.join(snapshotsDir, file), 'utf-8');
        if (!raw.includes(symbol)) continue;
        const parsed = JSON.parse(raw) as { disclosureDate?: string; holdings?: Array<{ symbol?: string; weight?: number; shares?: number }> };
        const hit = (parsed.holdings ?? []).find(h => h.symbol === symbol);
        if (!hit) continue;
        holdings.push({
          etf,
          snapshotDate: parsed.disclosureDate ?? file.replace(/^etf-snap-[^-]+-/, '').replace(/\.json$/, ''),
          weight: hit.weight,
          shares: hit.shares,
        });
      } catch {
        // skip bad files
      }
    }
    return holdings.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  } catch {
    return [];
  }
}

async function fetchSectorPeers(market: 'TW' | 'CN', scanDate: string): Promise<unknown> {
  return fetchJSON(`${SELF_BASE}/api/scanner/results?market=${market}&date=${scanDate}&direction=long&mtf=daily`);
}

async function fetchFundamentals(symbol: string): Promise<ZhuFundamentalsLite | null> {
  const res = await fetchJSON(`${SELF_BASE}/api/fundamentals/${encodeURIComponent(symbol)}?mode=full`);
  // apiOk wraps as { ok: true, data: FundamentalsData }
  if (!res || typeof res !== 'object') return null;
  const data = (res as { data?: ZhuFundamentalsLite }).data;
  if (!data || typeof data !== 'object') return null;
  return data;
}

async function fetchMarketTrend(market: 'TW' | 'CN', date: string): Promise<ZhuMarketTrendLite | null> {
  const res = await fetchJSON(`${SELF_BASE}/api/scanner/market-trend?market=${market}&date=${date}`);
  if (!res || typeof res !== 'object') return null;
  const r = res as { market?: 'TW' | 'CN'; date?: string | null; trend?: string };
  if (!r.trend) return null;
  return { market: r.market ?? market, date: r.date ?? date, trend: r.trend };
}

async function fetchNews(market: 'TW' | 'CN', symbol: string): Promise<ZhuNewsLite | null> {
  // News API 只支援 TW（底層走 TWSE name lookup + 台股 RSS 來源），CN 個股直接跳過
  // 避免吃 4s timeout
  if (market !== 'TW') return null;
  const bare = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  if (!/^\d{4,6}$/.test(bare)) return null;
  const res = await fetchJSON(`${SELF_BASE}/api/news/${bare}`);
  if (!res || typeof res !== 'object') return null;
  const r = res as {
    ok?: boolean;
    fetchedAt?: string;
    hasNews?: boolean;
    aggregateSentiment?: number;
    summary?: string;
    articles?: Array<{
      score?: number;
      label?: 'positive' | 'negative' | 'neutral';
      item?: { title?: string; source?: string; publishedAt?: string };
    }>;
  };
  return {
    fetchedAt: r.fetchedAt ?? new Date().toISOString(),
    hasNews: r.hasNews ?? false,
    aggregateSentiment: r.aggregateSentiment ?? 0,
    summary: r.summary ?? '',
    recent: (r.articles ?? []).slice(0, 5).map(a => ({
      title: a.item?.title ?? '',
      source: a.item?.source ?? '',
      publishedAt: a.item?.publishedAt ?? '',
      label: a.label ?? 'neutral',
      score: a.score ?? 0,
    })),
  };
}

// ── 從 prefetch 結果推導 lights 用的衍生欄位 ───────────────────────────────

interface InstSummary {
  consecutiveForeignBuy: number;
  consecutiveForeignSell: number;
}

function summarizeInstitutional(inst: unknown): InstSummary {
  if (!Array.isArray(inst)) return { consecutiveForeignBuy: 0, consecutiveForeignSell: 0 };
  let buy = 0, sell = 0;
  for (const row of inst) {
    const r = row as { foreignNet?: number };
    if (typeof r.foreignNet !== 'number') break;
    if (r.foreignNet > 0) { buy++; if (sell > 0) break; }
    else if (r.foreignNet < 0) { sell++; if (buy > 0) break; }
    else break;
  }
  return { consecutiveForeignBuy: buy, consecutiveForeignSell: sell };
}

function extractChipScore(chip: unknown): number | undefined {
  if (!chip || typeof chip !== 'object') return undefined;
  const c = chip as { chipScore?: number; score?: number; chipSignal?: string; chipGrade?: string };
  // 顯式「無資料」狀態 → 視為缺資料，不要把 chipScore=0 誤判成低分
  // /api/chip 對小型股/上櫃/資料源未涵蓋時回 chipSignal='無資料'、chipGrade='—'、chipScore=0
  if (c.chipSignal === '無資料' || c.chipGrade === '—') return undefined;
  return c.chipScore ?? c.score;
}

function extractMarginUtilRate(chip: unknown): number | undefined {
  if (!chip || typeof chip !== 'object') return undefined;
  const c = chip as { marginUtilRate?: number };
  return c.marginUtilRate;
}

interface SectorPeerSummary {
  sameIndustryCount: number;
  selfRank: number | null;
}

function summarizeSectorPeers(sectorPeers: unknown, symbol: string): SectorPeerSummary | null {
  if (!sectorPeers || typeof sectorPeers !== 'object') return null;
  const sessions = (sectorPeers as { sessions?: Array<{ results?: Array<{ symbol?: string; industry?: string; sixConditionsScore?: number }> }> }).sessions;
  const results = sessions?.[0]?.results;
  if (!Array.isArray(results) || results.length === 0) return null;

  // 找這檔的 industry
  const me = results.find(r => r.symbol === symbol);
  if (!me?.industry) return null;
  const myIndustry = me.industry;

  // 同產業 sixCond 排序（降序）
  const peers = results
    .filter(r => r.industry === myIndustry)
    .sort((a, b) => (b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0));

  // 取同產業 top10
  const top10 = peers.slice(0, 10);
  const selfIdx = top10.findIndex(r => r.symbol === symbol);
  return {
    sameIndustryCount: top10.length,
    selfRank: selfIdx >= 0 ? selfIdx + 1 : null,
  };
}

/** 平行打所有 prefetch，個別失敗不影響其他 */
export async function prefetchZhuChart(opts: {
  market: 'TW' | 'CN';
  symbol: string;
  date: string;
  /** 走圖頁送過來的個股技術數字（用來算 technical/chip lights） */
  technical?: {
    sixCond?: number;
    trendState?: '多頭' | '空頭' | '盤整' | string;
    closePrice?: number;
    ma20?: number | null;
    ma60?: number | null;
    longProhibitionsCount?: number;
  };
}): Promise<ZhuPrefetchData> {
  const { market, symbol, date, technical } = opts;
  const errors: string[] = [];

  const [inst, chip, lockwatch, etfHoldings, sectorPeers, fundamentals, marketTrend, news] = await Promise.all([
    fetchInstitutional(symbol).catch(e => { errors.push(`institutional: ${e instanceof Error ? e.message : e}`); return null; }),
    fetchChip(symbol).catch(e => { errors.push(`chip: ${e instanceof Error ? e.message : e}`); return null; }),
    fetchLockwatch(market, symbol).catch(e => { errors.push(`lockwatch: ${e instanceof Error ? e.message : e}`); return null; }),
    findETFHoldings(symbol).catch(e => { errors.push(`etf: ${e instanceof Error ? e.message : e}`); return [] as NonNullable<ZhuPrefetchData['etfHoldings']>; }),
    fetchSectorPeers(market, date).catch(e => { errors.push(`sectorPeers: ${e instanceof Error ? e.message : e}`); return null; }),
    fetchFundamentals(symbol).catch(e => { errors.push(`fundamentals: ${e instanceof Error ? e.message : e}`); return null; }),
    fetchMarketTrend(market, date).catch(e => { errors.push(`marketTrend: ${e instanceof Error ? e.message : e}`); return null; }),
    fetchNews(market, symbol).catch(e => { errors.push(`news: ${e instanceof Error ? e.message : e}`); return null; }),
  ]);

  // 算 suggestedLights / suggestedGrade
  const instSummary = summarizeInstitutional(inst);
  const sectorSummary = summarizeSectorPeers(sectorPeers, symbol);
  const lightsInput: ChartLightsInput = {
    sixCond: technical?.sixCond,
    trendState: technical?.trendState,
    closePrice: technical?.closePrice,
    ma20: technical?.ma20,
    ma60: technical?.ma60,
    longProhibitionsCount: technical?.longProhibitionsCount,
    chipScore: extractChipScore(chip),
    consecutiveForeignBuy: instSummary.consecutiveForeignBuy,
    consecutiveForeignSell: instSummary.consecutiveForeignSell,
    marginUtilRate: extractMarginUtilRate(chip),
    fundamentals: fundamentals ? {
      eps: fundamentals.eps,
      epsYoY: fundamentals.epsYoY,
      revenueMoM: fundamentals.revenueMoM,
      revenueYoY: fundamentals.revenueYoY,
      per: fundamentals.per,
      pbr: fundamentals.pbr,
      dividendYield: fundamentals.dividendYield,
    } : null,
    sectorPeers: sectorSummary,
  };
  const suggestedLights = computeChartLights(lightsInput);
  const suggestedGrade = computeGrade(suggestedLights);

  return {
    institutional: inst,
    chip,
    lockwatch,
    etfHoldings,
    sectorPeers,
    fundamentals,
    marketTrend,
    news,
    suggestedLights,
    suggestedGrade,
    fetchErrors: errors.length ? errors : undefined,
  };
}
