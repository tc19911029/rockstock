import { NextRequest } from 'next/server';
import { getEastMoneyQuote } from '@/lib/datasource/EastMoneyRealtime';
import { getFugleQuote, isFugleAvailable } from '@/lib/datasource/FugleProvider';
import { readIntradaySnapshot, type IntradaySnapshot } from '@/lib/datasource/IntradayCache';
import { assessIntradayFreshness } from '@/lib/datasource/intradayFreshness';
import { getQuoteSnapshotDate, isMarketPollingWindow } from '@/lib/datasource/marketHours';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { apiOk, apiError } from '@/lib/api/response';
import { resolveMisTradePrice, parseMisPrice } from '@/lib/datasource/TWSERealtime';
import { getCNChineseName, getTWChineseName } from '@/lib/datasource/TWSENames';
import { expectedTwSymbol } from '@/lib/datasource/twSymbolMarket';

// mis.twse 需要 Referer=fibest.jsp，否則 WAF 回空 msgArray（2026-04-21）
const MIS_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

// ── 無資料負快取（避免 polling 對已下市/打錯代號重跑整條 fallback chain）──────────────
// 已下市 / 打錯 / 暫時無報價的代號，冷查詢會把 TWSE(10s)→Fugle→L2 或 騰訊(5s)→EastMoney→L2
// 全跑一輪才放棄；前台每 30s polling 重來一次很浪費（重啟後上游冷時單一冷標的就要 3-4 秒）。
// 命中報價的代號永遠即時、會清掉負快取，不影響有效標的（合約 #6：不改有效標的的 provider 路由，
// 只是「確認過這輪沒資料」的代號短期略過）。指數(^TWII)/純英文(NVDA) market='unknown' 本來就
// 不進 tw/cn、不打上游，已是 fail-fast；負快取補的是「數字格式正確但其實查不到」的代號。
const NO_DATA_TTL_MS = 90_000;
const noDataUntil = new Map<string, number>(); // resolved symbol → 略過到期的 epoch ms

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
      };
    }
    return null;
  }));
  return settled.filter((quote): quote is QuoteTick => quote !== null);
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
      if (!sym || actualPrice <= 0) continue;

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
          if (!sym || actualPrice <= 0) continue;
          const changePct = prevClose > 0
            ? +((actualPrice - prevClose) / prevClose * 100).toFixed(2)
            : 0;
          const original = missing.find(s => s.replace(/\.(TW|TWO)$/i, '') === sym);
          results.push({
            symbol: original ?? `${sym}.TWO`,
            price: actualPrice,
            changePercent: changePct,
            name: d.n as string || undefined,
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
          results.push({ symbol: sym, price: fq.close, changePercent: changePct, name: fq.name || undefined });
        }
      } catch { /* Fugle fallback failed */ }
    }));
  }

  // Fallback 2: L2 快照（Fugle 也失敗時用盤中快照）
  const afterFugle = symbols.filter(
    s => !results.some(r => r.symbol.replace(/\.(TW|TWO)$/i, '') === s.replace(/\.(TW|TWO)$/i, '')),
  );
  if (afterFugle.length > 0) {
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
      const snap = await readIntradaySnapshot('TW', today);
      if (snap) {
        for (const sym of afterFugle) {
          const code = sym.replace(/\.(TW|TWO)$/i, '');
          const q = snap.quotes.find(qq => qq.symbol === code);
          if (q && q.close > 0) {
            results.push({ symbol: sym, price: q.close, changePercent: q.changePercent ?? 0, name: q.name || undefined });
          }
        }
      }
    } catch { /* L2 fallback failed */ }
  }

  return results;
}

// ── 陸股即時報價（騰訊 → 東方財富 fallback）────────────────────────────────

/** 騰訊一次拿 close+prevClose+name；EastMoney clist 收盤後 f2 不等於日K收盤（疑似盤後參考價），改 fallback */
async function fetchCNTencentQuote(code: string, suffix?: 'SS' | 'SZ'): Promise<{ close: number; prevClose: number; name: string } | null> {
  try {
    // suffix 權威：避免 000001.SS 上證指數誤路由到 sz000001 平安銀行
    const prefix = suffix === 'SS' ? 'sh'
      : suffix === 'SZ' ? 'sz'
      : code[0] === '6' || code[0] === '9' ? 'sh' : 'sz';
    const url = `https://qt.gtimg.cn/q=${prefix}${code}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const match = text.match(/="(.+)"/);
    if (!match) return null;
    const f = match[1].split('~');
    const close = parseFloat(f[3]) || 0;
    const prevClose = parseFloat(f[4]) || 0;
    const name = f[1] || '';
    if (close <= 0) return null;
    return { close, prevClose, name };
  } catch {
    return null;
  }
}

async function fetchCNQuotes(symbols: string[]): Promise<QuoteTick[]> {
  if (symbols.length === 0) return [];

  const results: QuoteTick[] = [];

  await Promise.allSettled(symbols.map(async (sym) => {
    const code = sym.replace(/\.(SS|SZ)$/i, '');
    const cnSuffix = /\.SS$/i.test(sym) ? 'SS' : /\.SZ$/i.test(sym) ? 'SZ' : undefined;

    // Tencent 優先：close 與日K收盤一致
    const tencent = await fetchCNTencentQuote(code, cnSuffix);
    if (tencent && tencent.close > 0) {
      const changePct = tencent.prevClose > 0
        ? +((tencent.close - tencent.prevClose) / tencent.prevClose * 100).toFixed(2)
        : 0;
      results.push({
        symbol: sym,
        price: tencent.close,
        changePercent: changePct,
        name: tencent.name || undefined,
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
async function fetchFundNav(code: string): Promise<{ nav: number; changePercent: number; name: string } | null> {
  try {
    const res = await fetch(
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fundf10.eastmoney.com/' }, signal: AbortSignal.timeout(6000) },
    );
    const json = await res.json() as { Data?: { LSJZList?: Array<{ DWJZ?: string; JZZZL?: string }> } };
    const row = json?.Data?.LSJZList?.[0];
    const nav = parseFloat(row?.DWJZ ?? '');
    if (nav > 0) return { nav, changePercent: parseFloat(row?.JZZZL ?? '0') || 0, name: '' };
  } catch { /* try fundgz fallback */ }

  try {
    const res = await fetch(`https://fundgz.1234567.com.cn/js/${code}.js`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://fund.eastmoney.com/' },
      signal: AbortSignal.timeout(6000),
    });
    const text = await res.text();
    const m = text.match(/jsonpgz\((\{.+?\})\)/);
    if (m) {
      const d = JSON.parse(m[1]) as { dwjz?: string; gszzl?: string; name?: string };
      const nav = parseFloat(d.dwjz ?? '');
      if (nav > 0) return { nav, changePercent: parseFloat(d.gszzl ?? '0') || 0, name: d.name ?? '' };
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
      results.push({ symbol: sym, price: r.nav, changePercent: r.changePercent, name: r.name || undefined });
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

  // 負快取：略過近期確認「無資料」的代號，避免每次 polling 重跑整條 fallback chain。
  // 有效/命中過的代號不在內，照常即時查；market='unknown' 本來就不查（已 fail-fast）。
  const now = Date.now();
  const fetchable = entries.filter(e => e.market !== 'unknown' && (noDataUntil.get(e.resolved) ?? 0) <= now);
  const twEntries = fetchable.filter(e => e.market === 'TW');
  const cnEntries = fetchable.filter(e => e.market === 'CN');
  const fundEntries = fetchable.filter(e => e.market === 'FUND');
  const twLive = isMarketPollingWindow('TW');
  const cnLive = isMarketPollingWindow('CN');

  // 並行抓取（傳入 resolved symbol，結果 symbol 改回 original）
  const [twQuotes, cnQuotes, fundQuotes] = await Promise.all([
    (twLive ? fetchTWSEQuotes(twEntries.map(e => e.resolved)) : fetchFinalL1Quotes(twEntries, 'TW')).then(qs =>
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
    if (!twLive || missingTW.length === 0) return [] as typeof quotes;
    const lookupTW = getQuoteSnapshotDate('TW');
    try {
      const twSnap = await readIntradaySnapshot('TW', lookupTW);
      if (!twSnap) return [] as typeof quotes;
      return buildFreshSnapshotFallback(missingTW, 'TW', twSnap);
    } catch { return [] as typeof quotes; }
  };

  const [cnFilled, twFilled] = await Promise.all([cnFallback(), twFallback()]);
  quotes.push(...cnFilled, ...twFilled);

  // 更新負快取：這次有去抓的代號 —— 命中清除、仍缺則標記略過 NO_DATA_TTL_MS
  for (const e of fetchable) {
    if (quotes.some(q => q.symbol === e.original)) noDataUntil.delete(e.resolved);
    else noDataUntil.set(e.resolved, now + NO_DATA_TTL_MS);
  }
  if (noDataUntil.size > 2000) { // 防無界成長：清掉過期項
    for (const [k, exp] of noDataUntil) if (exp <= now) noDataUntil.delete(k);
  }

  return apiOk(
    { quotes },
    { headers: { 'Cache-Control': 'max-age=15, stale-while-revalidate=30' } },
  );
}
