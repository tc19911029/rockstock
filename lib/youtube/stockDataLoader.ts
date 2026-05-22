/**
 * 八大面向資料 loader (MVP 4 完整版)。
 *
 * 對指定 TW 股票代號 (e.g. "2330")，並行抓 6 個 per-stock 面向 + 1 個 macro：
 *   技術 / 籌碼 / 基本面 / 消息 / 產業 / 治理 / 大盤
 *   估值併在 fundamental 內（PER/PBR/殖利率）
 *
 * 來源：
 *   technical / chip / fundamental / news → 本地 internal API endpoint
 *   industry / governance                  → FinMind 直連
 *
 * 每筆都附 provenance：source URL、fetched_at、freshness_status。
 * 目的：給 questionBuilder 整合進 question payload，讓 skill 分析時有事實 vs 主持人說法的對照。
 *
 * 設計：
 *   - 每維獨立 try/catch，單一失敗不影響其他
 *   - 並行抓 6 維，速度上限 = 最慢那維
 */

const API_BASE = process.env.YOUTUBE_DATA_API_BASE || 'http://localhost:3000';

export type FreshnessStatus = 'fresh' | 'stale' | 'unavailable' | 'error';

export interface DimensionResult<T> {
  data: T | null;
  source: string;
  fetched_at: string;       // ISO
  freshness: FreshnessStatus;
  error: string | null;
}

export interface StockDataBundle {
  stock_code: string;        // '2330'
  technical: DimensionResult<TechnicalData>;
  chip: DimensionResult<ChipData>;
  fundamental: DimensionResult<FundamentalData>;
  news: DimensionResult<NewsData>;
  industry: DimensionResult<IndustryData>;
  governance: DimensionResult<GovernanceData>;
}

export interface IndustryData {
  stock_name: string;
  industry_category: string;     // e.g. '半導體業'
  market_type: string;           // 'twse' / 'tpex'
}

export interface GovernanceData {
  /** 外資持股比率（%） */
  foreign_ownership_pct: number | null;
  /** 外資持股 4 週前比率（%） */
  foreign_ownership_pct_4w_ago: number | null;
  /** 外資持股 4 週變化（pp）— 正=外資長期加碼 */
  foreign_ownership_delta_4w: number | null;
  /** 外資餘額比率（可投資餘額 / 總股本）（%） */
  foreign_remaining_ratio: number | null;
  data_date: string | null;
}

// ── Dimension shapes (拉到的子集) ──────────────────────────────

export interface TechnicalData {
  /** 最後一根日 K */
  last_candle: { date: string; o: number; h: number; l: number; c: number; v: number } | null;
  /** 近 N 日趨勢摘要 */
  trend_summary: {
    change_pct_1d: number | null;
    change_pct_5d: number | null;
    change_pct_20d: number | null;
    ma5: number | null;
    ma10: number | null;
    ma20: number | null;
    ma60: number | null;
    /** 高於 MA20 幅度 (%) */
    above_ma20_pct: number | null;
    /** 近 20 日最高 / 收盤 ratio (= 1 表示創波段高) */
    pct_off_20d_high: number | null;
  };
}

export interface ChipData {
  foreign_net: number | null;          // 外資買賣超 (張)
  trust_net: number | null;
  dealer_net: number | null;
  total_inst_net: number | null;
  margin_balance: number | null;       // 融資餘額
  margin_net: number | null;           // 當日融資增減
  short_balance: number | null;        // 融券餘額
  day_trade_ratio: number | null;      // 當沖比率
  large_holder_pct: number | null;     // 大戶持股比率
  chip_score: number | null;           // 0-100
  chip_grade: string | null;           // S/A/B/C/D
  chip_signal: string | null;          // 文字描述
}

export interface FundamentalData {
  eps_recent_4q: number | null;
  eps_yoy: number | null;
  gross_margin_pct: number | null;
  net_margin_pct: number | null;
  per: number | null;
  pbr: number | null;
  dividend_yield_pct: number | null;
  revenue_latest_month: { month: string; revenue: number; mom: number | null; yoy: number | null } | null;
}

export interface NewsData {
  item_count: number;
  recent_titles: string[];               // top 5 titles
  sentiment: {
    overall_score: number | null;        // -1..+1
    bullish_count: number | null;
    bearish_count: number | null;
  } | null;
}

/** 大盤資金面快照（一日一次抓，全市場共用，不是 per-stock） */
export interface MacroData {
  /** 加權指數 */
  taiex: { last_close: number | null; change_pct_1d: number | null; change_pct_20d: number | null; above_ma20_pct: number | null } | null;
  /** 櫃買指數 */
  otc: { last_close: number | null; change_pct_1d: number | null; change_pct_20d: number | null; above_ma20_pct: number | null } | null;
  /** 美股代表（NASDAQ） — 可能無資料 */
  nasdaq: { last_close: number | null; change_pct_1d: number | null } | null;
  /** 評估市場狀態：多頭/盤整/空頭 (依 TAIEX above_ma20_pct + 趨勢) */
  market_regime: '多頭' | '盤整' | '空頭' | 'unknown';
}

// ── helper: fetch with timeout ─────────────────────────────────

async function fetchJson(url: string, timeoutMs = 30_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── per-dimension loaders ──────────────────────────────────────

export async function loadTechnical(stockCode: string): Promise<DimensionResult<TechnicalData>> {
  const fetched_at = new Date().toISOString();
  const url = `${API_BASE}/api/stock?symbol=${stockCode}&interval=1d&period=3mo`;
  try {
    const resp = (await fetchJson(url)) as Record<string, unknown>;
    const candles = (resp.candles ?? []) as Array<Record<string, number | string>>;
    if (!Array.isArray(candles) || candles.length === 0) {
      return { data: null, source: url, fetched_at, freshness: 'unavailable', error: 'no candles' };
    }
    const last = candles[candles.length - 1];
    const closes = candles.map(c => Number(c.close ?? c.c ?? 0)).filter(n => Number.isFinite(n));
    const lastClose = Number(last.close ?? last.c ?? 0);
    const prev1 = candles[Math.max(0, candles.length - 2)];
    const prev5 = candles[Math.max(0, candles.length - 6)];
    const prev20 = candles[Math.max(0, candles.length - 21)];
    const last20Highs = candles.slice(-20).map(c => Number(c.high ?? c.h ?? 0));
    const max20 = Math.max(...last20Highs);
    const ma5 = simpleAvg(closes.slice(-5));
    const ma10 = simpleAvg(closes.slice(-10));
    const ma20 = simpleAvg(closes.slice(-20));
    const ma60 = closes.length >= 60 ? simpleAvg(closes.slice(-60)) : null;

    return {
      data: {
        last_candle: {
          date: String(last.date),
          o: Number(last.open ?? last.o ?? 0),
          h: Number(last.high ?? last.h ?? 0),
          l: Number(last.low ?? last.l ?? 0),
          c: lastClose,
          v: Number(last.volume ?? last.v ?? 0),
        },
        trend_summary: {
          change_pct_1d: prev1 && prev1 !== last
            ? pct(lastClose, Number(prev1.close ?? prev1.c ?? 0))
            : null,
          change_pct_5d: prev5 && prev5 !== last
            ? pct(lastClose, Number(prev5.close ?? prev5.c ?? 0))
            : null,
          change_pct_20d: prev20 && prev20 !== last
            ? pct(lastClose, Number(prev20.close ?? prev20.c ?? 0))
            : null,
          ma5, ma10, ma20, ma60,
          above_ma20_pct: ma20 != null ? pct(lastClose, ma20) : null,
          pct_off_20d_high: max20 > 0
            ? Number((((lastClose - max20) / max20) * 100).toFixed(2))
            : null,
        },
      },
      source: url, fetched_at,
      freshness: isFresh(String(last.date), 5) ? 'fresh' : 'stale',
      error: null,
    };
  } catch (err) {
    return { data: null, source: url, fetched_at, freshness: 'error', error: (err as Error).message };
  }
}

function simpleAvg(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sum = arr.reduce((s, n) => s + n, 0);
  return Number((sum / arr.length).toFixed(2));
}

function pct(a: number, b: number): number | null {
  if (!b) return null;
  return Number((((a - b) / b) * 100).toFixed(2));
}

export async function loadChip(stockCode: string): Promise<DimensionResult<ChipData>> {
  const fetched_at = new Date().toISOString();
  const url = `${API_BASE}/api/chip?symbol=${stockCode}`;
  try {
    const resp = (await fetchJson(url)) as Record<string, unknown>;
    return {
      data: {
        foreign_net: numOrNull(resp.foreignBuy ?? resp.foreign_net),
        trust_net: numOrNull(resp.trustBuy ?? resp.trust_net),
        dealer_net: numOrNull(resp.dealerBuy ?? resp.dealer_net),
        total_inst_net: numOrNull(resp.totalInstitutional ?? resp.total_inst_net),
        margin_balance: numOrNull(resp.marginBalance),
        margin_net: numOrNull(resp.marginNet),
        short_balance: numOrNull(resp.shortBalance),
        day_trade_ratio: numOrNull(resp.dayTradeRatio),
        large_holder_pct: numOrNull(resp.largeHolderPct),
        chip_score: numOrNull(resp.chipScore),
        chip_grade: typeof resp.chipGrade === 'string' ? resp.chipGrade : null,
        chip_signal: typeof resp.chipSignal === 'string' ? resp.chipSignal : null,
      },
      source: url, fetched_at, freshness: 'fresh', error: null,
    };
  } catch (err) {
    return { data: null, source: url, fetched_at, freshness: 'error', error: (err as Error).message };
  }
}

export async function loadFundamental(stockCode: string): Promise<DimensionResult<FundamentalData>> {
  const fetched_at = new Date().toISOString();
  const url = `${API_BASE}/api/fundamentals/${stockCode}?mode=full`;
  try {
    const resp = (await fetchJson(url)) as Record<string, unknown>;
    // wire format: { ok, data: { eps, epsYoY, ... } }
    const data = (resp.data ?? resp) as Record<string, unknown>;
    const latest = data.revenueLatest as Record<string, unknown> | null;
    return {
      data: {
        eps_recent_4q: numOrNull(data.eps),
        eps_yoy: numOrNull(data.epsYoY),
        gross_margin_pct: numOrNull(data.grossMargin),
        net_margin_pct: numOrNull(data.netMargin),
        per: numOrNull(data.per),
        pbr: numOrNull(data.pbr),
        dividend_yield_pct: numOrNull(data.dividendYield),
        revenue_latest_month: latest
          ? {
              month: String(latest.date ?? latest.month ?? ''),
              revenue: Number(latest.revenue ?? 0),
              mom: numOrNull(data.revenueMoM),
              yoy: numOrNull(data.revenueYoY),
            }
          : null,
      },
      source: url, fetched_at, freshness: 'fresh', error: null,
    };
  } catch (err) {
    return { data: null, source: url, fetched_at, freshness: 'error', error: (err as Error).message };
  }
}

export async function loadNews(stockCode: string): Promise<DimensionResult<NewsData>> {
  const fetched_at = new Date().toISOString();
  const url = `${API_BASE}/api/news/${stockCode}`;
  try {
    const resp = (await fetchJson(url)) as Record<string, unknown>;
    // wire format: { ok, ticker, articles, aggregateSentiment, summary, hasNews }
    const articles = (resp.articles ?? []) as Array<Record<string, unknown>>;
    const aggScore = numOrNull(resp.aggregateSentiment);
    return {
      data: {
        item_count: articles.length,
        recent_titles: articles.slice(0, 5).map(a => String(a.title ?? '')),
        sentiment: aggScore != null && resp.hasNews
          ? { overall_score: aggScore, bullish_count: null, bearish_count: null }
          : null,
      },
      source: url, fetched_at, freshness: 'fresh', error: null,
    };
  } catch (err) {
    return { data: null, source: url, fetched_at, freshness: 'error', error: (err as Error).message };
  }
}

export async function loadIndustry(stockCode: string): Promise<DimensionResult<IndustryData>> {
  const fetched_at = new Date().toISOString();
  const source = 'finmind:TaiwanStockInfo';
  try {
    const { getStockInfo } = await import('@/lib/datasource/FinMindClient');
    const info = await getStockInfo(stockCode);
    if (!info || !info.industry_category) {
      return { data: null, source, fetched_at, freshness: 'unavailable', error: 'no industry data' };
    }
    return {
      data: {
        stock_name: info.stock_name,
        industry_category: info.industry_category,
        market_type: info.market_type,
      },
      source, fetched_at, freshness: 'fresh', error: null,
    };
  } catch (err) {
    return { data: null, source, fetched_at, freshness: 'error', error: (err as Error).message };
  }
}

export async function loadGovernance(stockCode: string): Promise<DimensionResult<GovernanceData>> {
  const fetched_at = new Date().toISOString();
  const source = 'finmind:TaiwanStockShareholding';
  try {
    const { getGovernance } = await import('@/lib/datasource/FinMindClient');
    const g = await getGovernance(stockCode);
    if (!g) {
      return { data: null, source, fetched_at, freshness: 'unavailable', error: 'no governance data' };
    }
    return {
      data: {
        foreign_ownership_pct: g.foreign_ownership_pct,
        foreign_ownership_pct_4w_ago: g.foreign_ownership_pct_4w_ago,
        foreign_ownership_delta_4w: g.foreign_ownership_delta_4w,
        foreign_remaining_ratio: g.foreign_remaining_ratio,
        data_date: g.data_date,
      },
      source, fetched_at,
      freshness: g.data_date && isFresh(g.data_date, 7) ? 'fresh' : 'stale',
      error: null,
    };
  } catch (err) {
    return { data: null, source, fetched_at, freshness: 'error', error: (err as Error).message };
  }
}

// ── 主入口：並行抓 8 維 ────────────────────────────────────────

export async function loadStockBundle(stockCode: string): Promise<StockDataBundle> {
  const [technical, chip, fundamental, news, industry, governance] = await Promise.all([
    loadTechnical(stockCode),
    loadChip(stockCode),
    loadFundamental(stockCode),
    loadNews(stockCode),
    loadIndustry(stockCode),
    loadGovernance(stockCode),
  ]);
  return {
    stock_code: stockCode,
    technical, chip, fundamental, news, industry, governance,
  };
}

// ── macro loader ─────────────────────────────────────────────

export async function loadMacro(): Promise<DimensionResult<MacroData>> {
  const fetched_at = new Date().toISOString();
  const sources: string[] = [];

  async function fetchIndex(symbol: string): Promise<{
    last_close: number | null; change_pct_1d: number | null;
    change_pct_20d: number | null; above_ma20_pct: number | null;
  } | null> {
    const url = `${API_BASE}/api/stock?symbol=${encodeURIComponent(symbol)}&interval=1d&period=3mo`;
    sources.push(url);
    try {
      const resp = (await fetchJson(url)) as Record<string, unknown>;
      const candles = (resp.candles ?? []) as Array<Record<string, number | string>>;
      if (!Array.isArray(candles) || candles.length < 2) return null;
      const last = candles[candles.length - 1];
      const prev1 = candles[candles.length - 2];
      const prev20 = candles[Math.max(0, candles.length - 21)];
      const closes = candles.map(c => Number(c.close ?? c.c ?? 0)).filter(Number.isFinite);
      const ma20 = closes.length >= 20 ? simpleAvg(closes.slice(-20)) : null;
      const lastClose = Number(last.close ?? last.c ?? 0);
      return {
        last_close: lastClose,
        change_pct_1d: pct(lastClose, Number(prev1.close ?? prev1.c ?? 0)),
        change_pct_20d: prev20 ? pct(lastClose, Number(prev20.close ?? prev20.c ?? 0)) : null,
        above_ma20_pct: ma20 != null ? pct(lastClose, ma20) : null,
      };
    } catch { return null; }
  }

  const [taiex, otc, nasdaq] = await Promise.all([
    fetchIndex('^TWII'),
    fetchIndex('^TWOII'),     // TPEx index. May not exist.
    fetchIndex('^IXIC'),       // NASDAQ Composite. May not exist if not configured.
  ]);

  // regime: TAIEX above_ma20_pct > +2% → 多頭; < -2% → 空頭; else → 盤整
  let regime: MacroData['market_regime'] = 'unknown';
  if (taiex?.above_ma20_pct != null) {
    if (taiex.above_ma20_pct > 2) regime = '多頭';
    else if (taiex.above_ma20_pct < -2) regime = '空頭';
    else regime = '盤整';
  }

  return {
    data: { taiex, otc, nasdaq, market_regime: regime },
    source: sources.join(' | '),
    fetched_at,
    freshness: taiex ? 'fresh' : 'unavailable',
    error: null,
  };
}

/** 批次抓多檔股票（並行）。建議上限 ~20 檔避免同時打 internal API 太多。 */
export async function loadStockBundles(stockCodes: string[], concurrency = 4): Promise<StockDataBundle[]> {
  const out: StockDataBundle[] = [];
  for (let i = 0; i < stockCodes.length; i += concurrency) {
    const batch = stockCodes.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(c => loadStockBundle(c)));
    out.push(...results);
  }
  return out;
}

// ── helpers ────────────────────────────────────────────────────

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isFresh(dateYmd: string, withinDays: number): boolean {
  try {
    const dt = new Date(dateYmd);
    const ageMs = Date.now() - dt.getTime();
    return ageMs < withinDays * 86400_000;
  } catch { return false; }
}
