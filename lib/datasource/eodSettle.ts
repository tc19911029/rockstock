/**
 * EOD Settlement Reconciliation — 盤後對賬機制
 *
 * 設計動機（2026-05-13）：
 * 過去資料管線只有「拿到一個就用」邏輯，遇到 vendor 出包（mis.twse 鎖漲停 bug、
 * TPEx Cloudflare、FinMind token 過期）就靜默漏掃／寫錯。每次都要用戶反映才修。
 *
 * 新設計：盤後跑一次「強制對賬」，對每一檔當日 K，從多個 vendor 拿資料，
 *   - 至少 2 源 close 一致（差距 < tolerance）→ 視為 settled，寫進 L1
 *   - 多源不一致 / 只有 1 源 / 全失敗 → 標 pending，T+1 重試（包括 AI WebFetch fallback）
 *
 * Vendor 優先序：
 *   TW: TWSE openapi (raw) → EODHD (raw) → Yahoo Chart → Tencent (僅 ETF/權證能拿)
 *   CN: EastMoney → Tencent → EODHD → Yahoo Chart
 */

import { eodhdHistProvider } from './EODHDHistProvider';
import { yahooProvider } from './YahooDataProvider';
import { tencentHistProvider } from './TencentHistProvider';
import { eastMoneyHistProvider } from './EastMoneyHistProvider';
import { finmindHistProvider } from './FinMindHistProvider';
import { isValidTwTick, snapTwTick, isTwEtf } from './twTick';
import type { Candle } from '@/types';
import type { VendorBatchCache } from './eodSettleBatch';
import { lookupBulkQuote } from './eodSettleBatch';

export type Market = 'TW' | 'CN';

export interface VendorQuote {
  vendor: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SettleStatus =
  | 'settled-multi-source'      // ≥2 vendor close 一致
  | 'settled-single-source'      // 只有 1 vendor 回，但仍寫入（標警告）
  | 'pending-multi-disagree'     // 多 vendor 但 close 不一致
  | 'pending-no-vendor-data'     // 全部 vendor 沒回
  | 'skipped-already-correct';   // L1 已有當日資料且與 vendor 一致

export interface SettleResult {
  symbol: string;
  market: Market;
  date: string;
  status: SettleStatus;
  vendors: VendorQuote[];
  settled?: VendorQuote;          // 最終決定寫進 L1 的（status=settled-*  才有）
  existing?: VendorQuote;         // L1 既有值（若有）
  disagreements?: string[];       // multi-disagree 時的 close 差距列表
  warning?: string;
}

const CLOSE_AGREE_TOLERANCE = 0.005; // 0.5% — vendor 之間 close 允許差距

function isClose(a: number, b: number): boolean {
  if (a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.max(a, b) < CLOSE_AGREE_TOLERANCE;
}

/** Volume 單位 normalize 到 L1 標準：TW=張、CN=股
 *  vendor 各家原始單位：
 *    TWSE/TPEx provider 已 / 1000 變張
 *    EODHD/Yahoo/Tencent/EastMoney 給「股」
 *  → 對 TW，把「股」級 vendor 的 volume / 1000 才能跟 TWSE 比 */
function normalizeVolume(rawVolume: number, vendorName: string, market: Market): number {
  if (market === 'TW' && (vendorName === 'EODHD' || vendorName === 'Yahoo' || vendorName === 'Tencent' || vendorName === 'EastMoney')) {
    return Math.round(rawVolume / 1000);
  }
  return rawVolume;
}

const PER_VENDOR_TIMEOUT_MS = 8000;

async function fetchOne(
  provider: { name: string; getCandlesRange: (s: string, sd: string, ed: string) => Promise<Candle[]> },
  symbol: string,
  date: string,
  market: Market,
): Promise<VendorQuote | null> {
  try {
    // 用 race 強制每個 vendor 在 timeout 內回，避免 1 個 vendor hang 卡死整個 batch
    const arr = await Promise.race([
      provider.getCandlesRange(symbol, date, date),
      new Promise<Candle[]>((_, reject) =>
        setTimeout(() => reject(new Error(`${provider.name} timeout`)), PER_VENDOR_TIMEOUT_MS)),
    ]);
    const c = arr.find(x => x.date === date);
    if (!c || !c.close || c.close <= 0) return null;
    return {
      vendor: provider.name,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: normalizeVolume(c.volume, provider.name, market),
    };
  } catch {
    return null;
  }
}

type ReconcileResult = { settled?: VendorQuote; status: SettleStatus; disagreements?: string[]; warning?: string };

/**
 * TW 檔位守衛：封存前若收盤非合法檔位（FinMind 被 402 熔斷缺席時，只剩 Yahoo/EODHD 的中間價，
 * 如 100-500 區間出現 158.75）→ snap 到最近合法檔位 + 標警，保證 L1 永不寫入次檔位偽價。
 * CN 檔位規則不同，不套用。詳見 [[twTick]] / docs。
 */
function finalizeTwTick(q: VendorQuote, status: SettleStatus, market: Market, isEtf: boolean): ReconcileResult {
  if (market === 'TW' && q.close > 0 && !isValidTwTick(q.close, isEtf)) {
    const snapped: VendorQuote = {
      ...q,
      open: isValidTwTick(q.open, isEtf) ? q.open : snapTwTick(q.open, isEtf),
      high: isValidTwTick(q.high, isEtf) ? q.high : snapTwTick(q.high, isEtf),
      low: isValidTwTick(q.low, isEtf) ? q.low : snapTwTick(q.low, isEtf),
      close: snapTwTick(q.close, isEtf),
    };
    return { settled: snapped, status, warning: `次檔位收盤 ${q.close}(vendor=${q.vendor}) → snap ${snapped.close}` };
  }
  return { settled: q, status };
}

/** 從多 vendor 結果決定 settled 值。isEtf：TW ETF/ETN（00 開頭）套較細檔位表（見 [[twTick]]）。 */
export function reconcile(quotes: VendorQuote[], market: Market, isEtf = false): ReconcileResult {
  if (quotes.length === 0) return { status: 'pending-no-vendor-data' };
  if (quotes.length === 1) {
    return finalizeTwTick(quotes[0], 'settled-single-source', market, isEtf);
  }

  // 找一組「至少 2 vendor close 一致」的 vendors
  for (let i = 0; i < quotes.length; i++) {
    for (let j = i + 1; j < quotes.length; j++) {
      if (isClose(quotes[i].close, quotes[j].close)) {
        // 一致群：與 quotes[i] 收盤一致的所有 vendor（已按原優先序）。
        const agreeing = quotes.filter(q => isClose(q.close, quotes[i].close));
        // TW 優先挑「檔位合法」的收盤：合法 159 勝過中間價 158.75，即使兩者在 0.5% 容差內被視為一致；
        // 一致群內無合法者才退回最高優先序，並由 finalizeTwTick snap。volume 取一致群最大值。
        const base = (market === 'TW' ? agreeing.find(q => isValidTwTick(q.close, isEtf)) : undefined) ?? agreeing[0];
        const maxVol = Math.max(...agreeing.map(q => q.volume), 0);
        return finalizeTwTick(
          { ...base, volume: maxVol > 0 ? maxVol : base.volume },
          'settled-multi-source',
          market,
          isEtf,
        );
      }
    }
  }

  // 多 vendor 但無一致對
  const disagreements = quotes.map(q => `${q.vendor}=${q.close.toFixed(2)}`);
  return { status: 'pending-multi-disagree', disagreements };
}

/**
 * 對單檔當日 K 跑對賬。
 *
 * 為了大量並行不被 TWSE provider 每檔 10s 拖死，TWSE/TPEx/EastMoney 改走 batch
 * prefetch（先一次拉整日 table，每檔 lookup map）。per-symbol API 走 EODHD/Yahoo/Tencent。
 */
export async function settleSymbol(
  symbol: string,
  market: Market,
  date: string,
  existing?: VendorQuote,
  batchCache?: VendorBatchCache,
): Promise<SettleResult> {
  const quotes: VendorQuote[] = [];

  // 1. 從 batch cache 拿（TWSE/TPEx/EastMoney bulk）— 不打 API
  if (batchCache) {
    const bulkQ = lookupBulkQuote(batchCache, symbol, market);
    if (bulkQ) quotes.push(bulkQ);
  }

  // 2. Per-symbol providers — TW: FinMind + EODHD + Yahoo  | CN: 4 源
  //    TWSE provider 走 batch cache（不在這裡）
  //    EastMoney provider for CN 也已被 batch 取代（雖然 batch 目前 stub）
  //    FinMind 2026-05-20 補進 TW 鏈路（之前只有 EODHD + Yahoo，TPEx 小型股若 EODHD
  //    沒回資料就只剩 Yahoo 對打 L1 → pending-multi-disagree 暴增）
  const perSymProviders = market === 'TW'
    ? [finmindHistProvider, eodhdHistProvider, yahooProvider]
    : [eastMoneyHistProvider, tencentHistProvider, eodhdHistProvider, yahooProvider];

  const settled = await Promise.allSettled(
    perSymProviders.map(p => fetchOne(p, symbol, date, market)),
  );
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) quotes.push(r.value);
  }

  // 若 existing 也加入比對（讓 L1 既有值參與多數決）
  if (existing && existing.close > 0) {
    quotes.push({ ...existing, vendor: 'L1-existing' });
  }

  const { settled: settledQuote, status, disagreements, warning: tickWarning } = reconcile(quotes, market, isTwEtf(symbol));
  const warnings = [
    tickWarning,
    status === 'settled-single-source' ? '只有 1 vendor 回，未經多源驗證' : null,
  ].filter(Boolean);
  return {
    symbol,
    market,
    date,
    status,
    vendors: quotes,
    settled: settledQuote,
    existing,
    disagreements,
    warning: warnings.length ? warnings.join('；') : undefined,
  };
}

/** Volume 單位換算：TW 寫入 L1 用「張」，CN 用「股」 */
export function normalizeVolumeForL1(quote: VendorQuote, market: Market, vendorName?: string): number {
  // 各 vendor 的 volume 單位（已在 provider 內部統一處理）：
  //   TWSE openapi: 已為「股」(stored in raw API)，我們的 provider 換算為「張」
  //   EODHD: 「股」
  //   Yahoo: 「股」
  //   EastMoney/Tencent: 「股」
  // 為了一致，這層強制：market=TW 若 vendor 是 raw「股」級別 → / 1000
  // 但 provider getCandlesRange 預期已轉成 L1 格式
  return quote.volume;
}
