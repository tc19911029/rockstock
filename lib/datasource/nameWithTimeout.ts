/**
 * 中文名稱查詢的逾時包覆 —— 單一事實來源。
 *
 * getTWChineseName / getCNChineseName 冷啟動會去打 TWSE / TPEx / ISIN（台股 name-map）
 * 或 EastMoney / 騰訊（陸股），在 fake-IP DNS 環境下 Node fetch 會卡數十秒。
 * 任何「在 request 熱路徑上查中文名」的地方（/api/stock、/api/news、/api/watchlist/conditions…）
 * 都必須走這支，逾時就回 null（呼叫端用代號當名稱），絕不讓查名稱卡住整個 response。
 *
 * 名稱純屬 nice-to-have；name-map 會在背景慢慢建好，下次查就有名。
 */
import { getTWChineseName, getCNChineseName } from './TWSENames';

export const NAME_LOOKUP_BUDGET_MS = Number(process.env.STOCK_NAME_BUDGET_MS) || 3000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(fallback); }
    }, ms);
    p.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(fallback); } },
    );
  });
}

export function twNameWithTimeout(code: string, budgetMs = NAME_LOOKUP_BUDGET_MS): Promise<string | null> {
  return withTimeout(getTWChineseName(code).catch(() => null), budgetMs, null);
}

export function cnNameWithTimeout(code: string, suffix?: 'SS' | 'SZ', budgetMs = NAME_LOOKUP_BUDGET_MS): Promise<string | null> {
  return withTimeout(getCNChineseName(code, suffix).catch(() => null), budgetMs, null);
}
