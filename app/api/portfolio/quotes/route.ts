import { NextRequest } from 'next/server';
import { getEastMoneyQuote } from '@/lib/datasource/EastMoneyRealtime';
import { getFugleQuote, isFugleAvailable } from '@/lib/datasource/FugleProvider';
import { readIntradaySnapshot, type IntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';
import { getQuoteSnapshotDate, isAfterMarketClose, isMarketOpen, isMarketPollingWindow } from '@/lib/datasource/marketHours';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { apiOk, apiError } from '@/lib/api/response';
import { getTWSESingleIntraday, resolveMisTradePrice, parseMisPrice, parseMisDate, parseMisUpdatedAt } from '@/lib/datasource/TWSERealtime';
import { getCNChineseName, getTWChineseName } from '@/lib/datasource/TWSENames';
import { expectedTwSymbol } from '@/lib/datasource/twSymbolMarket';
import { isPlaceholderStockName } from '@/lib/stocks/stockIdentity';
import { assessQuoteFreshness, type QuoteFreshnessStatus } from '@/lib/datasource/quoteFreshness';
import { fetchQuote } from '@/lib/cn-sanse/cnQuote';

// mis.twse 需要 Referer=fibest.jsp，否則 WAF 回空 msgArray（2026-04-21）
const MIS_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

// 暫時無報價不能做負快取：上游恢復後下一輪必須立刻重試，否則 30 秒 polling
// 會被 90 秒「無資料」記憶擋住，使用者仍看到舊價。
// ═══════════════════════════════════════════════════════════════════════════════
// 輕量即時報價 API — 只回傳 price + changePercent，用於持倉 polling
// 支援台股（TWSE mis）+ 陸股（騰訊/東方財富）批次查詢
// ═══════════════════════════════════════════════════════════════════════════════

export interface QuoteTick {
  /** 原始請求代號，供既有持倉／自選股以相同 key 套用報價。 */
  symbol: string;
  /** 股票主檔校正後的交易所代號；新增持倉時應優先採用。 */
  canonicalSymbol?: string;
  price: number;
  changePercent: number;
  name?: string;
  /** 行情所屬交易日；前端不得只靠 request 時間假定是今天。 */
  asOf?: string | null;
  /** 實際採用的來源，供健康檢查與事故排查。 */
  source?: string;
  /** true 時價格可供參考，但不可冒充最新行情。 */
  stale?: boolean;
  status?: QuoteFreshnessStatus;
  staleReason?: string;
  updatedAt?: string;
}

export type ResolvedEntry = {
  original: string;
  resolved: string;
  market: 'TW' | 'CN' | 'FUND' | 'unknown';
};

/**
 * 解析報價請求並以本地股票主檔校正台股上市／上櫃後綴。
 *
 * `original` 必須保留，否則持倉輪詢用 `3081.TW` 發問、API 回 `3081.TWO` 時，
 * React 端會找不到原 key；校正值另放在 `resolved/canonicalSymbol` 給新增持倉使用。
 */
export async function resolveQuoteEntries(rawSymbols: string[]): Promise<ResolvedEntry[]> {
  const entries: ResolvedEntry[] = rawSymbols.map(s => {
    if (/\.(TW|TWO)$/i.test(s)) return { original: s, resolved: s.toUpperCase(), market: 'TW' };
    if (/\.(SS|SZ)$/i.test(s)) return { original: s, resolved: s.toUpperCase(), market: 'CN' };
    if (/\.OF$/i.test(s)) return { original: s, resolved: s.toUpperCase(), market: 'FUND' };
    const digits = s.replace(/\D/g, '');
    if (/^\d{6}$/.test(digits)) {
      const suffix = digits[0] === '6' || digits[0] === '9' ? 'SS' : 'SZ';
      return { original: s, resolved: `${digits}.${suffix}`, market: 'CN' };
    }
    if (/^\d{4,5}$/.test(digits)) {
      return { original: s, resolved: `${digits}.TWO`, market: 'TW' };
    }
    return { original: s, resolved: s.toUpperCase(), market: 'unknown' };
  });

  return Promise.all(entries.map(async entry => {
    if (entry.market !== 'TW') return entry;
    const canonical = await expectedTwSymbol(entry.resolved);
    return canonical ? { ...entry, resolved: canonical } : entry;
  }));
}

async function resolveEntryName(entry: ResolvedEntry): Promise<string | undefined> {
  const code = entry.resolved.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  if (entry.market === 'TW') return (await getTWChineseName(code)) ?? undefined;
  if (entry.market === 'CN') {
    const suffix = /\.SS$/i.test(entry.resolved) ? 'SS' : /\.SZ$/i.test(entry.resolved) ? 'SZ' : undefined;
    return (await getCNChineseName(code, suffix)) ?? undefined;
  }
  return undefined;
}

/**
 * 所有 provider/fallback 最後都過這個出口：清掉「name=代號」占位，並用股票主檔補正式名稱。
 * 這可避免任何單一行情來源降級時，把裸代號傳進持股／自選股／題材等持久化流程。
 */
export async function enrichQuoteNames(
  quotes: QuoteTick[],
  entries: ResolvedEntry[],
): Promise<QuoteTick[]> {
  return Promise.all(quotes.map(async quote => {
    const entry = entries.find(candidate => candidate.original === quote.symbol)
      ?? entries.find(candidate => candidate.resolved === quote.canonicalSymbol)
      ?? entries.find(candidate => candidate.resolved.replace(/\.(TW|TWO|SS|SZ)$/i, '') === quote.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, ''));
    if (!entry) return quote;
    const canonicalSymbol = quote.canonicalSymbol ?? entry.resolved;
    if (!isPlaceholderStockName(quote.name, canonicalSymbol)) {
      return { ...quote, canonicalSymbol, name: quote.name!.trim() };
    }
    const resolvedName = await resolveEntryName({ ...entry, resolved: canonicalSymbol });
    return {
      ...quote,
      canonicalSymbol,
      ...(resolvedName ? { name: resolvedName } : { name: undefined }),
    };
  }));
}

/**
 * 只用通過新鮮度檢查的 L2 補 L1／即時來源缺口。
 *
 * CN 盤後有一段時間日 K provider 尚未全數定稿，但 15:45 強制刷新後的全市場 L2
 * 已是收盤值；若完全禁用 L2，昨天的掃描卡會有數百檔繼續顯示昨天漲幅。
 * 反過來也不能無條件相信 L2，因此統一套用盤中 6 分鐘／盤後收盤時間守門。
 */
export function buildFreshSnapshotFallback(
  entries: ResolvedEntry[],
  market: 'TW' | 'CN',
  snapshot: IntradaySnapshot,
  now = new Date(),
): QuoteTick[] {
  const freshness = assessIntradayFreshness(market, snapshot, now);
  if (freshness.stale) return [];

  const byCode = new Map(snapshot.quotes.map((quote) => [quote.symbol, quote]));
  const out: QuoteTick[] = [];
  for (const entry of entries) {
    const code = entry.resolved.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const quote = byCode.get(code);
    if (!quote || quote.close <= 0) continue;
    if (market === 'TW' && quote.isActualTrade === false) continue;
    out.push({
      symbol: entry.original,
      canonicalSymbol: entry.resolved,
      price: quote.close,
      changePercent: quote.changePercent ?? 0,
      name: quote.name || undefined,
      asOf: snapshot.date,
      source: 'l2',
      stale: false,
      status: isMarketOpen(market, now) ? 'live' : 'final',
      updatedAt: snapshot.updatedAt,
    });
  }
  return out;
}

/** 休市／深夜報價以正式 L1 日 K 為準；L2 可能只是盤中快照，不能冒充收盤價。 */
export async function fetchFinalL1Quotes(entries: ResolvedEntry[], market: 'TW' | 'CN'): Promise<QuoteTick[]> {
  const settled = await Promise.all(entries.map(async (entry): Promise<QuoteTick | null> => {
    const code = entry.resolved.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const candidates = market === 'TW'
      ? [...new Set([entry.resolved, `${code}.TW`, `${code}.TWO`])]
      : [entry.resolved];

    for (const candidate of candidates) {
      const data = await readCandleFile(candidate, market);
      const last = data?.candles.at(-1);
      if (!last || !(last.close > 0)) continue;
      const previous = data?.candles.at(-2)?.close ?? last.close;
      const changePercent = previous > 0
        ? +((last.close - previous) / previous * 100).toFixed(2)
        : 0;
      return {
        symbol: entry.original,
        canonicalSymbol: candidate,
        price: last.close,
        changePercent,
        name: await resolveEntryName({ ...entry, resolved: candidate }),
        asOf: last.date,
        source: 'l1',
      };
    }
    return null;
  }));
  return settled.filter((quote): quote is QuoteTick => quote !== null);
}

/**
 * 台股同交易日盤後補價：正式 L1 尚未發布時，以 MIS 的最後實際成交價覆蓋昨日 L1。
 *
 * 只在交易日收盤後執行，並要求 provider 回傳日期等於今天；任一檔失敗都保留原 L1，
 * 不讓單一外部請求拖垮整批持倉報價。
 */
export async function fetchSameDayTWCloseQuotes(
  entries: ResolvedEntry[],
  now = new Date(),
): Promise<QuoteTick[]> {
  if (entries.length === 0 || !isAfterMarketClose('TW', now)) return [];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
  const out: QuoteTick[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
    const code = entry.resolved.replace(/\.(TW|TWO)$/i, '');
    try {
      const quote = await getTWSESingleIntraday(code);
      if (!quote || quote.date !== today || !(quote.close > 0)) continue;
      const previous = quote.previousClose ?? quote.close;
      const changePercent = previous > 0
        ? +((quote.close - previous) / previous * 100).toFixed(2)
        : 0;
      out.push({
        symbol: entry.original,
        canonicalSymbol: entry.resolved,
        price: quote.close,
        changePercent,
        name: quote.name || undefined,
        asOf: quote.date,
        source: 'mis-final',
        stale: false,
        status: 'final',
        updatedAt: quote.updatedAt,
      });
    } catch {
      // 單檔失敗交給 L2/final L1，不阻斷其他持股。
    }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, entries.length) }, () => worker()));
  return out;
}

// ── 台股即時報價（TWSE mis API）─────────────────────────────────────────────

async function fetchTWSEQuotes(symbols: string[]): Promise<QuoteTick[]> {
  if (symbols.length === 0) return [];

  const exCh = symbols.map(s => {
    const clean = s.replace(/\.(TW|TWO)$/i, '');
    if (s.toUpperCase().includes('.TWO') || s.toUpperCase().includes('TWO')) {
      return `otc_${clean}.tw`;
    }
    return `tse_${clean}.tw`;
  }).join('|');

  const results: QuoteTick[] = [];

  try {
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}`;
    const res = await fetch(url, {
      headers: MIS_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();

    const found = new Set<string>();
    for (const d of json?.msgArray ?? []) {
      const sym = (d.c as string) || '';
      const prevClose = parseMisPrice(d.y);
      // z='-' 代表這批沒有實際撮合；b/a 中價不是成交價，不能當現價。
      // 留在 missing 清單，交由下方 Fugle / L2 補實際成交價。
      const actualPrice = resolveMisTradePrice(d as Record<string, string | undefined>);

      // mis 對不存在的 channel（例如 6187 上櫃但被送 tse_）會回 d.c="" + 全 0 的空殼，
      // 直接跳過避免產生 ".TW" / ".TWO" 空殼結果
      if (!sym) continue;
      const asOf = parseMisDate(d.d as string | undefined) ?? null;
      const updatedAt = parseMisUpdatedAt(d as Record<string, string | undefined>);
      const volume = parseInt(String(d.v ?? '0').replace(/,/g, ''), 10) || 0;
      if (actualPrice <= 0) {
        // 今日尚無成交／停牌：昨收是合法參考價，但必須明確標 no-trade，不能冒充 live trade。
        if (asOf && volume === 0 && prevClose > 0) {
          found.add(sym);
          const original = symbols.find(s => s.replace(/\.(TW|TWO)$/i, '') === sym);
          results.push({
            symbol: original ?? `${sym}.TW`, price: prevClose, changePercent: 0,
            name: d.n as string || undefined, asOf, source: 'mis-no-trade', updatedAt,
            stale: false, status: 'no-trade',
          });
        }
        continue;
      }

      const changePct = prevClose > 0
        ? +((actualPrice - prevClose) / prevClose * 100).toFixed(2)
        : 0;

      found.add(sym);

      // Find the original symbol with suffix
      const original = symbols.find(s => s.replace(/\.(TW|TWO)$/i, '') === sym);
      results.push({
        symbol: original ?? `${sym}.TW`,
        price: actualPrice,
        changePercent: changePct,
        name: d.n as string || undefined,
        asOf,
        source: 'mis',
        updatedAt,
      });
    }

    // Retry missing as OTC
    const missing = symbols.filter(s => !found.has(s.replace(/\.(TW|TWO)$/i, '')));
    if (missing.length > 0) {
      const otcExCh = missing.map(c => `otc_${c.replace(/\.(TW|TWO)$/i, '')}.tw`).join('|');
      try {
        const otcRes = await fetch(
          `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${otcExCh}&json=1&delay=0&_=${Date.now()}`,
          { headers: MIS_HEADERS, signal: AbortSignal.timeout(8000) },
        );
        const otcJson = await otcRes.json();
        for (const d of otcJson?.msgArray ?? []) {
          const sym = (d.c as string) || '';
          const prevClose = parseMisPrice(d.y);
          const actualPrice = resolveMisTradePrice(d as Record<string, string | undefined>);
          if (!sym) continue;
          const asOf = parseMisDate(d.d as string | undefined) ?? null;
          const updatedAt = parseMisUpdatedAt(d as Record<string, string | undefined>);
          const volume = parseInt(String(d.v ?? '0').replace(/,/g, ''), 10) || 0;
          if (actualPrice <= 0) {
            if (asOf && volume === 0 && prevClose > 0) {
              const original = missing.find(s => s.replace(/\.(TW|TWO)$/i, '') === sym);
              results.push({
                symbol: original ?? `${sym}.TWO`, price: prevClose, changePercent: 0,
                name: d.n as string || undefined, asOf, source: 'mis-no-trade', updatedAt,
                stale: false, status: 'no-trade',
              });
            }
            continue;
          }
          const changePct = prevClose > 0
            ? +((actualPrice - prevClose) / prevClose * 100).toFixed(2)
            : 0;
          const original = missing.find(s => s.replace(/\.(TW|TWO)$/i, '') === sym);
          results.push({
            symbol: original ?? `${sym}.TWO`,
            price: actualPrice,
            changePercent: changePct,
            name: d.n as string || undefined,
            asOf,
            source: 'mis',
            updatedAt,
          });
        }
      } catch { /* OTC retry failed */ }
    }
  } catch { /* TWSE failed */ }

  // Fallback 1: Fugle（mis.twse 空回應時救場）
  const stillMissing = symbols.filter(
    s => !results.some(r => r.symbol.replace(/\.(TW|TWO)$/i, '') === s.replace(/\.(TW|TWO)$/i, '')),
  );
  if (stillMissing.length > 0 && isFugleAvailable()) {
    await Promise.allSettled(stillMissing.map(async (sym) => {
      const code = sym.replace(/\.(TW|TWO)$/i, '');
      try {
        const fq = await getFugleQuote(code);
        if (fq && fq.close > 0) {
          const changePct = fq.changePercent ?? (
            fq.prevClose && fq.prevClose > 0
              ? +((fq.close - fq.prevClose) / fq.prevClose * 100).toFixed(2)
              : 0
          );
          results.push({
            symbol: sym,
            price: fq.close,
            changePercent: changePct,
            name: fq.name || undefined,
            asOf: fq.date ?? null,
            source: 'fugle',
            updatedAt: fq.updatedAt,
          });
        }
      } catch { /* Fugle fallback failed */ }
    }));
  }

  return results;
}

// ── 陸股即時報價（騰訊 → 東方財富 fallback）────────────────────────────────

async function fetchCNQuotes(symbols: string[]): Promise<QuoteTick[]> {
  if (symbols.length === 0) return [];

  const results: QuoteTick[] = [];

  await Promise.allSettled(symbols.map(async (sym) => {
    const code = sym.replace(/\.(SS|SZ)$/i, '');
    const cnSuffix = /\.SS$/i.test(sym) ? 'SS' : /\.SZ$/i.test(sym) ? 'SZ' : undefined;

    // Tencent 優先：close 與日K收盤一致
    const tencent = await fetchQuote(sym);
    if (tencent && tencent.price > 0) {
      const changePct = tencent.prevClose > 0
        ? +((tencent.price - tencent.prevClose) / tencent.prevClose * 100).toFixed(2)
        : 0;
      results.push({
        symbol: sym,
        price: tencent.price,
        changePercent: changePct,
        asOf: tencent.date ?? null,
        source: 'tencent',
        updatedAt: tencent.updatedAt,
      });
      return;
    }

    // Fallback: EastMoney
    try {
      const quote = await getEastMoneyQuote(code, cnSuffix);
      if (quote && quote.close > 0) {
        const prevClose = quote.prevClose ?? 0;
        const changePct = prevClose > 0
          ? +((quote.close - prevClose) / prevClose * 100).toFixed(2)
          : 0;
        results.push({
          symbol: sym,
          price: quote.close,
          changePercent: changePct,
          name: quote.name || undefined,
          asOf: quote.date ?? null,
          source: 'eastmoney',
          updatedAt: quote.updatedAt,
        });
      }
    } catch { /* skip failed symbol */ }
  }));

  return results;
}

// ── 場外基金淨值（天天基金 估值 → 歷史淨值 fallback）───────────────────────────

/**
 * 場外開放式基金（.OF）「現價」= 最新「已定盤」單位淨值(NAV)，跟銀行/券商 App 市值對齊。
 *
 * 1) 東財歷史淨值 API（lsjz）為主：row[0] 永遠是最新定盤淨值 DWJZ + 真實當日漲跌 JZZZL。
 *    （估值端點 fundgz 的 dwjz 對部分基金會「慢一天」— 例：019917 已出 06-05=1.3750，
 *      fundgz 仍回 06-04=1.3956 → 必須以 lsjz 為準才不會抓到過期淨值。）
 * 2) fundgz.1234567.com.cn fallback：lsjz 掛掉時救場（dwjz + 估算漲跌 gszzl + name）。
 */
async function fetchFundNav(code: string): Promise<{ nav: number; changePercent: number; name: string; asOf: string | null; source: string } | null> {
  try {
    const res = await fetch(
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fundf10.eastmoney.com/' }, signal: AbortSignal.timeout(6000) },
    );
    const json = await res.json() as { Data?: { LSJZList?: Array<{ DWJZ?: string; JZZZL?: string; FSRQ?: string }> } };
    const row = json?.Data?.LSJZList?.[0];
    const nav = parseFloat(row?.DWJZ ?? '');
    if (nav > 0) return { nav, changePercent: parseFloat(row?.JZZZL ?? '0') || 0, name: '', asOf: row?.FSRQ ?? null, source: 'eastmoney-nav' };
  } catch { /* try fundgz fallback */ }

  try {
    const res = await fetch(`https://fundgz.1234567.com.cn/js/${code}.js`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fund.eastmoney.com/' },
      signal: AbortSignal.timeout(6000),
    });
    const text = await res.text();
    const m = text.match(/jsonpgz\((\{.+?\})\)/);
    if (m) {
      const d = JSON.parse(m[1]) as { dwjz?: string; gszzl?: string; name?: string; jzrq?: string };
      const nav = parseFloat(d.dwjz ?? '');
      if (nav > 0) return { nav, changePercent: parseFloat(d.gszzl ?? '0') || 0, name: d.name ?? '', asOf: d.jzrq ?? null, source: 'eastmoney-fundgz' };
    }
  } catch { /* give up */ }

  return null;
}

async function fetchFundQuotes(symbols: string[]): Promise<QuoteTick[]> {
  if (symbols.length === 0) return [];
  const results: QuoteTick[] = [];
  await Promise.allSettled(symbols.map(async (sym) => {
    const code = sym.replace(/\.OF$/i, '');
    const r = await fetchFundNav(code);
    if (r && r.nav > 0) {
      results.push({ symbol: sym, price: r.nav, changePercent: r.changePercent, name: r.name || undefined, asOf: r.asOf, source: r.source });
    }
  }));
  return results;
}

// ── Route Handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbolsParam = searchParams.get('symbols');

  if (!symbolsParam) {
    return apiError('symbols required', 400);
  }

  const rawSymbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (rawSymbols.length === 0) {
    return apiError('no valid symbols', 400);
  }

  // 記住原始 key 供持倉輪詢套價，同時以股票主檔校正上市／上櫃後綴。
  const entries = await resolveQuoteEntries(rawSymbols);

  // 每輪都重試有效市場代號；unknown 仍 fail-fast。
  const fetchable = entries.filter(e => e.market !== 'unknown');
  const twEntries = fetchable.filter(e => e.market === 'TW');
  const cnEntries = fetchable.filter(e => e.market === 'CN');
  const fundEntries = fetchable.filter(e => e.market === 'FUND');
  const twLive = isMarketPollingWindow('TW');
  const cnLive = isMarketPollingWindow('CN');

  // 並行抓取（傳入 resolved symbol，結果 symbol 改回 original）
  const [twQuotes, cnQuotes, fundQuotes] = await Promise.all([
    (twLive
      ? fetchTWSEQuotes(twEntries.map(e => e.resolved))
      : fetchFinalL1Quotes(twEntries, 'TW').then(async l1Quotes => {
          const expectedDate = getQuoteSnapshotDate('TW');
          const unsettledEntries = twEntries.filter(entry => {
            const l1 = l1Quotes.find(quote => quote.symbol === entry.original);
            return !l1?.asOf || l1.asOf < expectedDate;
          });
          // 正式 L1 已到預期交易日就完成對帳，不再用暫時 MIS 覆蓋；只替仍落後的檔案補價。
          const sameDayQuotes = await fetchSameDayTWCloseQuotes(unsettledEntries);
          const replaced = new Set(sameDayQuotes.map(quote => quote.symbol));
          return [...l1Quotes.filter(quote => !replaced.has(quote.symbol)), ...sameDayQuotes];
        })
    ).then(qs =>
      qs.map(q => {
        const entry = twEntries.find(e => e.resolved.replace(/\.(TW|TWO)$/i, '') === q.symbol.replace(/\.(TW|TWO)$/i, ''));
        return entry ? { ...q, symbol: entry.original, canonicalSymbol: q.canonicalSymbol ?? entry.resolved } : q;
      })
    ),
    (cnLive ? fetchCNQuotes(cnEntries.map(e => e.resolved)) : fetchFinalL1Quotes(cnEntries, 'CN')).then(qs =>
      qs.map(q => {
        const entry = cnEntries.find(e => e.resolved.replace(/\.(SS|SZ)$/i, '') === q.symbol.replace(/\.(SS|SZ)$/i, ''));
        return entry ? { ...q, symbol: entry.original, canonicalSymbol: q.canonicalSymbol ?? entry.resolved } : q;
      })
    ),
    fetchFundQuotes(fundEntries.map(e => e.resolved)),
  ]);

  const quotes = [...twQuotes, ...cnQuotes, ...fundQuotes];

  // L2 快照補漏（EastMoney/騰訊/Fugle 掛掉時 + 週末/假日無 live 報價時）
  // CN + TW 並行 fallback（原本順序執行延遲 2x）
  const missingCN = cnEntries.filter(
    e => !quotes.some(q => q.symbol === e.original),
  );
  const missingTW = twEntries.filter(
    e => !quotes.some(q => q.symbol === e.original),
  );

  const cnFallback = async () => {
    if (missingCN.length === 0) return [] as typeof quotes;
    const lookupCN = getQuoteSnapshotDate('CN');
    try {
      const cnSnap = await readIntradaySnapshot('CN', lookupCN);
      if (!cnSnap) return [] as typeof quotes;
      return buildFreshSnapshotFallback(missingCN, 'CN', cnSnap);
    } catch { return [] as typeof quotes; }
  };

  const twFallback = async () => {
    if ((!twLive && !isAfterMarketClose('TW')) || missingTW.length === 0) return [] as typeof quotes;
    const lookupTW = getQuoteSnapshotDate('TW');
    try {
      const twSnap = await readIntradaySnapshot('TW', lookupTW);
      if (!twSnap) return [] as typeof quotes;
      return buildFreshSnapshotFallback(missingTW, 'TW', twSnap);
    } catch { return [] as typeof quotes; }
  };

  const [cnFilled, twFilled] = await Promise.all([cnFallback(), twFallback()]);
  quotes.push(...cnFilled, ...twFilled);

  const namedQuotes = await enrichQuoteNames(quotes, entries);
  const checkedAt = new Date().toISOString();
  const annotatedQuotes = namedQuotes.map(quote => {
    const entry = entries.find(candidate => candidate.original === quote.symbol);
    if (!entry) return quote;
    if (entry.market === 'FUND') {
      const validNavDate = typeof quote.asOf === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(quote.asOf)
        && Number.isFinite(new Date(`${quote.asOf}T00:00:00Z`).getTime());
      return {
        ...quote,
        stale: !validNavDate,
        status: validNavDate ? 'final' as const : 'delayed' as const,
        ...(!validNavDate ? { staleReason: '基金來源未提供有效淨值日期' } : {}),
      };
    }
    if (entry.market !== 'TW' && entry.market !== 'CN') return quote;

    // 即時 provider 成功時，該路徑已驗證為目前 session；休市 L1/MIS/L2 則在上方帶入真實日期。
    const asOf = quote.asOf ?? null;
    const freshness = assessQuoteFreshness(entry.market, asOf);
    const sourceFreshness = isMarketPollingWindow(entry.market)
      && quote.source !== 'l1'
      && quote.status !== 'no-trade'
      ? assessIntradayFreshness(entry.market, {
          date: asOf ?? '',
          updatedAt: quote.updatedAt ?? '',
          count: quote.price > 0 ? 1 : 0,
        })
      : null;
    const sourceStale = sourceFreshness?.stale ?? false;
    const staleReason = quote.staleReason
      ?? freshness.staleReason
      ?? (sourceStale ? sourceFreshness?.reason ?? '行情來源時間無效' : undefined);
    return {
      ...quote,
      asOf: freshness.asOf,
      source: quote.source ?? 'unknown',
      stale: quote.stale === true || freshness.stale || sourceStale,
      status: quote.stale === true || freshness.stale || sourceStale
        ? 'delayed'
        : (quote.status ?? freshness.status),
      ...(staleReason ? { staleReason } : {}),
      ...(quote.updatedAt ? { updatedAt: quote.updatedAt } : {}),
    };
  });

  const missingSymbols = entries
    .filter(entry => !annotatedQuotes.some(quote => quote.symbol === entry.original))
    .map(entry => entry.original);
  const staleSymbols = annotatedQuotes.filter(quote => quote.stale).map(quote => quote.symbol);

  return apiOk(
    {
      quotes: annotatedQuotes,
      checkedAt,
      status: missingSymbols.length > 0 || staleSymbols.length > 0 ? 'degraded' : 'fresh',
      staleSymbols,
      missingSymbols,
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
