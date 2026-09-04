import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { StockEntry } from './MarketScanner';
import { CN_DELISTED_SYMBOLS } from './cnDelistedSymbols';

const STOCKLIST_CACHE_PATH = path.join(process.cwd(), 'data', 'cn_stocklist.json');
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

interface StockListCache {
  updatedAt: string;
  stocks: StockEntry[];
}

/**
 * 東方財富以分頁回傳即時清單；若排序欄位在翻頁期間變動，同一代號可能跨頁重複。
 * 以 symbol 去重，並優先保留名稱／產業資訊較完整的版本。
 */
export function dedupeStockEntries(stocks: readonly StockEntry[]): StockEntry[] {
  const unique = new Map<string, StockEntry>();
  for (const stock of stocks) {
    const previous = unique.get(stock.symbol);
    if (!previous) {
      unique.set(stock.symbol, stock);
      continue;
    }
    unique.set(stock.symbol, {
      ...previous,
      ...stock,
      name: stock.name || previous.name,
      industry: stock.industry || previous.industry,
    });
  }
  return [...unique.values()];
}

/** 已經 Tencent 日K／名稱雙重確認的退市、吸收合併代號。 */
export async function loadRemovedCNStockSymbols(): Promise<Set<string>> {
  const removed = new Set<string>(CN_DELISTED_SYMBOLS);
  try {
    const raw = JSON.parse(await readFile(
      path.join(process.cwd(), 'data', 'cn-delisted-removed.json'),
      'utf8',
    )) as Array<{ symbol?: string }>;
    for (const symbol of raw.map((item) => item.symbol).filter((symbol): symbol is string => Boolean(symbol))) {
      removed.add(symbol);
    }
    return removed;
  } catch {
    return removed;
  }
}

async function withoutRemovedStocks(stocks: StockEntry[]): Promise<StockEntry[]> {
  const removed = await loadRemovedCNStockSymbols();
  return removed.size ? stocks.filter((stock) => !removed.has(stock.symbol)) : stocks;
}

/**
 * 讀取本地快取的 A 股清單（< 7 天有效）
 */
async function loadCachedStockList(): Promise<StockEntry[] | null> {
  try {
    const raw = await readFile(STOCKLIST_CACHE_PATH, 'utf-8');
    const cache: StockListCache = JSON.parse(raw);
    const age = Date.now() - new Date(cache.updatedAt).getTime();
    if (age < CACHE_MAX_AGE_MS && cache.stocks.length > 500) {
      return dedupeStockEntries(await withoutRemovedStocks(cache.stocks));
    }
  } catch { /* 快取不存在或格式錯誤 */ }
  return null;
}

/**
 * 儲存 A 股清單到本地快取
 */
async function saveCachedStockList(stocks: StockEntry[]): Promise<void> {
  try {
    const dir = path.dirname(STOCKLIST_CACHE_PATH);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const cache: StockListCache = {
      updatedAt: new Date().toISOString(),
      stocks: dedupeStockEntries(stocks),
    };
    const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
    await atomicFsPut(STOCKLIST_CACHE_PATH, JSON.stringify(cache));
  } catch { /* 寫入失敗不影響主流程 */ }
}

/**
 * 從東方財富 API 動態取得全部 A 股清單（含成交量排序）
 * 優先讀取本地快取（< 7 天），失敗才打 API
 *
 * API: push2.eastmoney.com → 全市場 A 股即時行情
 * f12=代碼, f14=名稱, f3=漲跌幅, f6=成交額
 * fs: m:0+t:6(滬A主板), m:1+t:2(深A主板)
 * 不含科創板(688xxx)和創業板(300xxx)
 */
export async function fetchEastMoneyStockList(): Promise<StockEntry[]> {
  // 優先讀取本地快取
  const cached = await loadCachedStockList();
  if (cached) return cached;
  const all: StockEntry[] = [];
  const pageSize = 100; // 東方財富 API 實際每頁最多 100 筆（台灣 IP 限制）
  let page = 1;
  const maxPages = 50; // 安全上限：3500 股 / 100 = 35 頁，多留 15 頁餘裕

  while (page <= maxPages) {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?' +
      // 股票代碼是穩定排序鍵；成交額 f6 在翻頁時持續變動，曾讓 9 檔跨頁重複，
      // 同時也可能把其他代號擠出完整母體。
      `pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f12` +
      '&fs=m:0+t:6,m:1+t:2' +
      '&fields=f12,f14,f3,f100';

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`EastMoney API ${res.status}`);
    const json = await res.json();
    const items: Array<{ f12: string; f14: string; f100?: string }> = json?.data?.diff ?? [];

    if (items.length === 0) break; // 沒有更多資料

    const filtered = items
      .filter(item => {
        const code = item.f12;
        // 排除 ST、*ST、退市、B股
        if (/ST|退市/.test(item.f14)) return false;
        // 排除 B 股（900xxx, 200xxx）
        if (code.startsWith('900') || code.startsWith('200')) return false;
        // 排除創業板（300xxx）和科創板（688xxx）
        if (code.startsWith('300') || code.startsWith('688')) return false;
        // 只保留有效 A 股代碼（6位數字）
        if (!/^\d{6}$/.test(code)) return false;
        return true;
      })
      .map(item => {
        const code = item.f12;
        // 轉換為 Yahoo Finance 格式：6xxxxx → .SS（上海），0/3xxxxx → .SZ（深圳）
        const suffix = code.startsWith('6') || code.startsWith('9') ? '.SS' : '.SZ';
        // f100 = 所屬行業（產業板塊），e.g. "電子元件", "銀行", "軟件開發"
        const industry = (typeof item.f100 === 'string' && item.f100 !== '-') ? item.f100 : undefined;
        const name = (item.f14 && item.f14 !== '-') ? item.f14 : code;
        return { symbol: `${code}${suffix}`, name, industry };
      });

    all.push(...filtered);

    // 如果本頁取得數量不足 pageSize，表示已是最後一頁
    if (items.length < pageSize) break;
    page++;
  }

  // 成功取得後存到本地快取
  const active = dedupeStockEntries(await withoutRemovedStocks(all));
  if (active.length > 500) {
    saveCachedStockList(active).catch(() => {});
  }

  if (active.length < 500) {
    console.warn(`[eastMoneyApi] 股票清單異常偏少: ${active.length} 檔（預期 3000+），可能 API 暫時異常`);
  }

  return active;
}
