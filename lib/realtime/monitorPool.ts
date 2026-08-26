/**
 * monitorPool — 即時警示監控池
 *
 * 聚合四來源：
 *   1. 持倉  ← data/agents/portfolio/holdings.json（TW 業務邏輯，目前只含 TW）
 *   2. Manual ← data/realtime/extra-symbols.json（陸股 / 沒進 holdings 的監控）
 *               isHolding=true 也會吃到 ma5-breakdown 持股獨享規則
 *   3. 自選股 ← /watchlist 走 zustand+localStorage（server side 看不到）
 *             → MVP 階段 skip；之後若 watchlist 持久化到 disk 再接
 *   4. 當日 scan 候選 ← data/agents/pool/{market}/{today}.json candidates[].symbol
 *
 * 規則：
 *   - 持倉/manual 永遠在池內
 *   - 其他來源 hard cap 至 REALTIME_RULES.POOL_HARD_CAP（含持倉），優先保持倉
 *   - dedup by symbol
 */

import { REALTIME_RULES } from '@/lib/config';
import { promises as fs } from 'fs';
import path from 'path';
import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { computeIndicators } from '@/lib/indicators';
import {
  darkCloudCover, bearishEngulfingHigh, bearishHaramiHigh,
  bearishPiercingHigh, bearishEncounterHigh, standardRedBlackHigh,
} from '@/lib/rules/twoBarReversalRules';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';
import { loadAllHoldings } from '@/lib/agents/portfolio/storage';
import { loadProfiles } from '@/lib/portfolio/profiles';
import { resolveHoldingReferencePrice } from '@/lib/portfolio/holdingReferencePrice';
import { evaluateHoldingDecision } from '@/lib/portfolio/evaluateHoldingDecision';
import type { PortfolioHolding } from '@/lib/agents/portfolio/types';

/**
 * 持倉保命警報層（holdingsGuard）需要的持倉資訊。
 * positionSide / entryHigh 派生逐字對齊 daily-action route（ui blob passthrough）。
 */
export interface MonitoredHoldingInfo {
  name: string;
  entryPrice: number;
  /** active stop 由正式持股決策入口派生；極端缺值才由 guard 套方向正確的保命線。 */
  stopLoss?: number;
  positionSide: 'long' | 'short';
  /** 做空回補停損 = ui.entryKbar.high（進場黑K最高點） */
  entryHigh?: number;
  /**
   * 漏網-3（2026-07-05）：昨日日K是否出現高檔轉折/變盤訊號（課程 CH2-6/2-9）。
   * 有 → guard 規則5 在開盤窗監看「開低=變盤確認」。每日快取、long 持倉才算。
   */
  reversalWatch?: { label: string; yLow: number; yClose: number };
  /** 同一股票若存在多個持股人，使用最嚴格保命線並保留來源供訊息辨識。 */
  profileNames?: string[];
}

export interface MonitoredSymbol {
  symbol: string;        // 帶 suffix：3661.TW / 603986.SS
  market: 'TW' | 'CN';
  source: 'holding' | 'manual' | 'watchlist' | 'scan' | 'lockroster';
  isHolding: boolean;
  /** 中文名（推播標題用）；來源檔有就帶，scan 候選常缺 → 缺省 fallback 代號 */
  name?: string;
  /** 只有 source='holding' 才帶（guard 規則1 停損判斷用） */
  holding?: MonitoredHoldingInfo;
  /**
   * 鎖股關鍵價（批次E 2026-07-05，漏網-12 v1）：source='lockroster' 才帶。
   * 盤中價越過 level → guard 規則7 推「越關鍵價」提醒（課程紀律：13:20 確認、13:25 掛，勿開盤追）。
   */
  lockTrigger?: { level: number; label: string; waitingFor: string; name: string };
}

export async function getActiveSymbols(): Promise<MonitoredSymbol[]> {
  const out: MonitoredSymbol[] = [];
  const seen = new Set<string>();

  const holdings = await readHoldings();
  for (const h of holdings) {
    if (seen.has(h.symbol)) continue;
    // 漏網-3（2026-07-05）：long 持倉補「昨日轉折訊號」旗標（每日快取，guard 規則5 用）
    if (h.holding && h.holding.positionSide === 'long') {
      h.holding.reversalWatch = await detectYesterdayReversalWatch(h.symbol, h.market);
    }
    out.push({ symbol: h.symbol, market: h.market, source: 'holding', isHolding: true, holding: h.holding, name: h.holding?.name });
    seen.add(h.symbol);
  }

  const extras = await readExtraSymbols();
  for (const x of extras) {
    if (seen.has(x.symbol)) continue;
    if (out.length >= REALTIME_RULES.POOL_HARD_CAP) break;
    out.push({ symbol: x.symbol, market: x.market, source: 'manual', isHolding: x.isHolding, name: x.name });
    seen.add(x.symbol);
  }

  // 鎖股名單（批次E 2026-07-05）：有關鍵觸發價的鎖股進監控池（≤15 檔，優先級高於 scan 候選）
  // 課程 CH5-6：鎖股就是在「等發動」— 盤中越過關鍵價要即時知道，不是等收盤。
  const lockEntries = await readLockRosterTriggers();
  for (const e of lockEntries) {
    if (seen.has(e.symbol)) continue;
    if (out.length >= REALTIME_RULES.POOL_HARD_CAP) break;
    out.push({
      symbol: e.symbol, market: e.market, source: 'lockroster', isHolding: false,
      lockTrigger: e.lockTrigger, name: e.lockTrigger.name,
    });
    seen.add(e.symbol);
  }

  for (const market of ['TW', 'CN'] as const) {
    if (out.length >= REALTIME_RULES.POOL_HARD_CAP) break;
    const candidates = await readPoolCandidates(market);
    for (const c of candidates) {
      if (out.length >= REALTIME_RULES.POOL_HARD_CAP) break;
      if (seen.has(c.symbol)) continue;
      out.push({
        symbol: c.symbol, market,
        source: 'scan', isHolding: false, name: c.name,
      });
      seen.add(c.symbol);
    }
  }

  return out;
}

/** 鎖股名單 → 監控項（只收有 triggerLevel 的；roster 本身 ≤15 檔） */
async function readLockRosterTriggers(): Promise<Array<{
  symbol: string; market: 'TW' | 'CN';
  lockTrigger: NonNullable<MonitoredSymbol['lockTrigger']>;
}>> {
  try {
    const { loadLockRoster } = await import('@/lib/storage/lockRosterStorage');
    const roster = await loadLockRoster('TW');
    return (roster?.entries ?? [])
      .filter(e => e.triggerLevel != null && e.triggerLevel > 0)
      .map(e => ({
        symbol: e.symbol,
        market: e.market,
        lockTrigger: {
          level: e.triggerLevel!,
          label: e.label,
          waitingFor: e.waitingFor,
          name: e.name,
        },
      }));
  } catch {
    return [];
  }
}

// ── 漏網-3：昨日高檔轉折/變盤訊號（課程 CH2-6/2-9「次日開盤定強弱」）───────────
//
// 讀 L1 日K（盤中時最後一根＝昨日已收盤 bar），跑高檔雙K轉折家族。
// 命中（WATCH 變盤或 SELL 吞噬/貫穿）→ 回 {label, 昨低, 昨收} 給 guard 規則5：
// 今晨開低 = 課程「開低確認變盤」→ 即時推播。每日每檔快取一次（30s 輪詢不重算）。

const reversalWatchCache = new Map<string, { date: string; rw?: { label: string; yLow: number; yClose: number } }>();

async function detectYesterdayReversalWatch(
  symbol: string,
  market: 'TW' | 'CN',
): Promise<{ label: string; yLow: number; yClose: number } | undefined> {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); // CST 日期
  const cached = reversalWatchCache.get(symbol);
  if (cached && cached.date === today) return cached.rw;

  let rw: { label: string; yLow: number; yClose: number } | undefined;
  try {
    const raw = await loadLocalCandles(symbol, market);
    if (raw && raw.length >= 25) {
      // L1 只有已收盤日K；若最後一根就是今天（罕見：盤前跑到已封存）也無妨 — 看最後一根
      const candles = computeIndicators(raw);
      const last = candles.length - 1;
      // 課程 CH2-6 高檔紅K+黑K 六組，任一成立 → 觀察次日「開低確認止漲」（guard 規則5）。
      // 2026-07-20 第七輪補漏：standardRedBlackHigh（第1組 標準長紅長黑）是 07-05 18:06 才新增的規則，
      // 而 guard 規則5 在同日 14:38 就寫好了 → 新規則沒回頭補進這份清單，命中時盤中開低推播永遠不會發。
      // ⚠️ 刻意不加 CH2-8 夜星家族：夜星是三根K棒、右邊長黑收盤「當下即確認」（發 SELL 不是 WATCH），
      //    塞進「等次日開低才確認」的管線反而會把已確認訊號往後拖延。
      const rules = [bearishEngulfingHigh, bearishPiercingHigh, bearishHaramiHigh, bearishEncounterHigh, darkCloudCover, standardRedBlackHigh];
      for (const rule of rules) {
        const r = rule.evaluate(candles, last, undefined as never);
        if (r) {
          rw = { label: r.label, yLow: candles[last].low, yClose: candles[last].close };
          break;
        }
      }
    }
  } catch { /* 缺K線 → 無旗標 */ }

  reversalWatchCache.set(symbol, { date: today, rw });
  return rw;
}

// ── readers ──────────────────────────────────────────────────────────────

async function readHoldings(): Promise<Array<{ symbol: string; market: 'TW' | 'CN'; holding?: MonitoredHoldingInfo }>> {
  const { profiles } = await loadProfiles();
  const grouped = new Map<string, {
    symbol: string;
    market: 'TW' | 'CN';
    variants: Array<{ info: MonitoredHoldingInfo; profileName: string }>;
  }>();
  await Promise.all(profiles.map(async profile => {
    const holdings = await loadAllHoldings(profile.id).catch(() => [] as PortfolioHolding[]);
    for (const h of holdings) {
      if (!h.symbol || h.status === 'closed' || /\.OF$/i.test(h.symbol)) continue;
      const market = h.market === 'CN' ? 'CN' : 'TW';
      const info = await toHoldingInfo(h, market);
      if (!info) continue;
      const key = `${market}:${h.symbol}`;
      const group = grouped.get(key) ?? { symbol: h.symbol, market, variants: [] };
      group.variants.push({ info, profileName: profile.name });
      grouped.set(key, group);
    }
  }));

  return [...grouped.values()].map(group => {
    // 多帳號同檔只抓一次報價。做多取最高停損、做空取最低回補線，確保不漏最早的保命觸發。
    const side = group.variants[0].info.positionSide;
    const sameSide = group.variants.filter(v => v.info.positionSide === side);
    const strictest = sameSide.reduce((best, candidate) => {
      const a = best.info.stopLoss;
      const b = candidate.info.stopLoss;
      if (a == null) return candidate;
      if (b == null) return best;
      return side === 'short' ? (b < a ? candidate : best) : (b > a ? candidate : best);
    });
    return {
      symbol: group.symbol,
      market: group.market,
      holding: {
        ...strictest.info,
        name: stockDisplayName(strictest.info.name, group.symbol),
        profileNames: group.variants.map(v => v.profileName),
      },
    };
  });
}

/** 派生停損與 daily-action 共用同一決策入口，不再只讀資料庫中的舊停損。 */
async function toHoldingInfo(h: PortfolioHolding, market: 'TW' | 'CN'): Promise<MonitoredHoldingInfo | undefined> {
  const positionSide: 'long' | 'short' = h.ui?.positionSide === 'short' ? 'short' : 'long';
  const entryKbar = h.ui?.entryKbar as { high?: number } | undefined;
  const entryHigh = typeof entryKbar?.high === 'number' ? entryKbar.high : undefined;
  let candles = await loadLocalCandles(h.symbol, market) ?? [];
  if ((!candles || candles.length === 0) && market === 'TW') {
    candles = await loadLocalCandles(h.symbol.replace(/\.TW$/, '.TWO'), market) ?? [];
  }
  const reference = resolveHoldingReferencePrice(h, candles);
  if (reference.price == null) return undefined;
  const activeStop = candles.length > 0
    ? evaluateHoldingDecision({
        symbol: h.symbol,
        market,
        entryDate: h.entryDate,
        entryPrice: reference.price,
        configuredStopLoss: h.stopLoss,
        previousActiveStop: h.riskState?.activeStopLoss,
        candles,
        ui: h.ui,
      }).activeStop.price
    : h.stopLoss;
  return {
    name: stockDisplayName(h.name, h.symbol),
    entryPrice: reference.price,
    stopLoss: typeof activeStop === 'number' && activeStop > 0 ? activeStop : undefined,
    positionSide,
    entryHigh,
  };
}

interface RawExtraSymbol {
  symbol: string;
  market: 'TW' | 'CN';
  name?: string;
  isHolding?: boolean;
}

async function readExtraSymbols(): Promise<Array<{ symbol: string; market: 'TW' | 'CN'; isHolding: boolean; name?: string }>> {
  try {
    const p = path.join(process.cwd(), 'data', 'realtime', 'extra-symbols.json');
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as { symbols?: RawExtraSymbol[] };
    return (parsed.symbols ?? [])
      .filter(s => s.symbol && (s.market === 'TW' || s.market === 'CN'))
      .map(s => ({ symbol: s.symbol, market: s.market, isHolding: s.isHolding ?? false, name: s.name }));
  } catch {
    return [];
  }
}

async function readPoolCandidates(market: 'TW' | 'CN'): Promise<Array<{ symbol: string; name?: string }>> {
  try {
    const today = todayInMarket(market);
    const p = path.join(process.cwd(), 'data', 'agents', 'pool', market, `${today}.json`);
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) return [];
    const age = Date.now() - stat.mtimeMs;
    if (age > REALTIME_RULES.SCAN_CANDIDATE_TTL_MS) return [];
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as { candidates?: Array<{ symbol: string; name?: string }> };
    return (parsed.candidates ?? []).filter(c => c.symbol);
  } catch {
    return [];
  }
}

function todayInMarket(market: 'TW' | 'CN'): string {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}
