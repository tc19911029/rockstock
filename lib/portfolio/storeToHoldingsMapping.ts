/**
 * UI Zustand portfolioStore → server holdings.json schema 映射（Phase 0.4）
 *
 * 為什麼有這個模組：
 *   - UI 持股事實源在 `store/portfolioStore.ts`（Zustand persist 到 localStorage）
 *   - server 端 `data/agents/portfolio/holdings.json` 是 portfolio-review skill / close-trade API
 *     / 月報 cron 讀的，schema 簡化版（沒有 entryKbar / triggerPrice / operationMode 等 UI 體驗欄位）
 *   - 同步時必須「蒸發 UI-only 欄位 + 對齊 server 必填欄位」，純函式好測
 *
 * 邊界：
 *   - market 缺失（舊資料）→ 從 symbol 後綴推導
 *   - stopLoss 缺失 → 預設 costPrice × 0.93（書本 7% 停損，與 holdingsImport 一致）
 *   - industry / target1 / target2 → UI 端沒存，server 端標 undefined
 *
 * 反向不需要做：server → UI 同步不在 Phase 0.4 範圍（UI 是事實源）
 *
 * **TW-only filter（2026-05-23 用戶決議「不要管陸股」memory `project_cn_excluded_from_path`）**：
 * batch mapping 預設跳過 CN，單筆 mapping 仍支援 CN 但呼叫端應自行檢查。
 */

import { marketFromSymbol } from '@/lib/utils/shareUnits';
import { STOP_LOSS_DEFAULT_PCT } from '@/lib/portfolio/holdingsImport';
import type { MarketId } from '@/lib/scanner/types';

/** 與 store/portfolioStore.ts PortfolioHolding 同欄位（避免循環 import） */
export interface StorePortfolioHolding {
  id: string;
  symbol: string;
  name: string;
  shares: number;
  costPrice: number;
  buyDate: string;
  market?: MarketId;
  notes?: string;
  triggerSignal?: string;
  // ... 其他 UI-only 欄位忽略
}

/** 與 lib/agents/portfolio/types.ts PortfolioHolding 對齊（但去掉 audit/status 欄位）*/
export interface ServerHoldingPayload {
  symbol: string;
  name: string;
  market: MarketId;
  entryDate: string;
  entryPrice: number;
  shares: number;
  stopLoss?: number;
  target1?: number;
  target2?: number;
  industry?: string;
  notes?: string;
}

export interface MappingResult {
  ok: boolean;
  payload?: ServerHoldingPayload;
  reason?: string;
}

/**
 * Zustand holding → server payload（純函式）
 *
 * 驗證失敗：缺 symbol / shares / costPrice / buyDate → ok=false
 * 容錯：market 缺失走 marketFromSymbol；stopLoss 缺失走預設 7%
 */
export function mapStoreToServerHolding(h: StorePortfolioHolding): MappingResult {
  if (!h.symbol || !/^[A-Za-z0-9._-]+$/.test(h.symbol)) {
    return { ok: false, reason: `symbol 格式錯 (${h.symbol})` };
  }
  if (!h.name || h.name.trim() === '') {
    return { ok: false, reason: 'name 為空' };
  }
  if (!Number.isFinite(h.shares) || h.shares <= 0 || !Number.isInteger(h.shares)) {
    return { ok: false, reason: `shares 必須為正整數 (got ${h.shares})` };
  }
  if (!Number.isFinite(h.costPrice) || h.costPrice <= 0) {
    return { ok: false, reason: `costPrice 必須為正數 (got ${h.costPrice})` };
  }
  if (!h.buyDate || !/^\d{4}-\d{2}-\d{2}$/.test(h.buyDate)) {
    return { ok: false, reason: `buyDate 格式錯，應為 YYYY-MM-DD (got ${h.buyDate})` };
  }

  const market = h.market ?? (marketFromSymbol(h.symbol) as MarketId);
  if (market !== 'TW' && market !== 'CN') {
    return { ok: false, reason: `無法推導市場 (symbol=${h.symbol})` };
  }

  return {
    ok: true,
    payload: {
      symbol: h.symbol,
      name: h.name,
      market,
      entryDate: h.buyDate,
      entryPrice: h.costPrice,
      shares: h.shares,
      // 書本 7% 停損預設（與 holdingsImport.applyDefaults 對齊）
      stopLoss: +(h.costPrice * (1 - STOP_LOSS_DEFAULT_PCT)).toFixed(2),
      // target1/target2/industry UI 端沒存
      notes: h.notes,
    },
  };
}

/** 批量映射，回逐項結果（失敗不擋其他）
 *
 * `excludeCn` 預設 `true` — 用戶 2026-05-23 決議「不要管陸股」memory
 * `project_cn_excluded_from_path`。陸股被 filter 不會出現在 rows 也不會進 rejections，
 * 改進 `skipped` 陣列方便 caller 顯示。
 */
export function mapStoreHoldingsToImportRows(
  holdings: readonly StorePortfolioHolding[],
  options: { excludeCn?: boolean } = {},
): {
  rows: Array<{
    symbol: string; name: string; shares: number; avgCost: number;
    entryDate: string; stopLoss: number; notes?: string;
  }>;
  rejections: Array<{ id: string; symbol: string; reason: string }>;
  skipped: Array<{ id: string; symbol: string; reason: string }>;
} {
  const excludeCn = options.excludeCn ?? true;
  const rows: ReturnType<typeof mapStoreHoldingsToImportRows>['rows'] = [];
  const rejections: ReturnType<typeof mapStoreHoldingsToImportRows>['rejections'] = [];
  const skipped: ReturnType<typeof mapStoreHoldingsToImportRows>['skipped'] = [];
  for (const h of holdings) {
    const r = mapStoreToServerHolding(h);
    if (!r.ok || !r.payload) {
      rejections.push({ id: h.id, symbol: h.symbol ?? '?', reason: r.reason ?? 'unknown' });
      continue;
    }
    if (excludeCn && r.payload.market === 'CN') {
      skipped.push({ id: h.id, symbol: r.payload.symbol, reason: 'cn_excluded_per_user_2026_05_23' });
      continue;
    }
    rows.push({
      symbol: r.payload.symbol,
      name: r.payload.name,
      shares: r.payload.shares,
      avgCost: r.payload.entryPrice,
      entryDate: r.payload.entryDate,
      stopLoss: r.payload.stopLoss!,
      ...(r.payload.notes ? { notes: r.payload.notes } : {}),
    });
  }
  return { rows, rejections, skipped };
}

/** 給單筆 sync 判斷是否該 fire（add/update 同步）— TW-only */
export function shouldSyncToServer(h: StorePortfolioHolding): boolean {
  const market = h.market ?? (h.symbol.match(/\.(SS|SZ)$/i) ? 'CN' : 'TW');
  return market === 'TW';
}

/** 給單檔 sync 用的 `/api/agents/portfolio` POST body */
export function toUpsertApiBody(payload: ServerHoldingPayload): Record<string, unknown> {
  return {
    ...payload,
    status: 'open',
    forcePrice: true,  // 均價可能跟單日 K 線對不上是正常的（5/22 偵測到的 bug 教訓）
  };
}
