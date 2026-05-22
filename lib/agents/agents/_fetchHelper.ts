/**
 * 共用的 internal API fetch helper（仿 zhuPrefetch.ts pattern）
 *
 * Agent prefetch 用，timeout + 不拋 — 失敗回 null，由 caller 寫進 fetchErrors
 */

const SELF_BASE = process.env.NEXT_INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const FETCH_TIMEOUT_MS = 4_000;

export async function fetchJSON(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function internalUrl(path: string): string {
  return `${SELF_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 統一去掉 .TW / .TWO 後綴（FinMind / TWSE API 的 ticker 純數字）*/
export function bareTicker(symbol: string): string {
  return symbol.replace(/\.(TW|TWO)$/i, '');
}
