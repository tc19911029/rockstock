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

/**
 * 持倉保命警報層（holdingsGuard）需要的持倉資訊。
 * positionSide / entryHigh 派生逐字對齊 daily-action route（ui blob passthrough）。
 */
export interface MonitoredHoldingInfo {
  name: string;
  entryPrice: number;
  /** 缺省時由 guard 用 DEFAULT_STOP_LOSS_MULT 補（單一事實在 holdingsActionEngine） */
  stopLoss?: number;
  positionSide: 'long' | 'short';
  /** 做空回補停損 = ui.entryKbar.high（進場黑K最高點） */
  entryHigh?: number;
}

export interface MonitoredSymbol {
  symbol: string;        // 帶 suffix：3661.TW / 603986.SS
  market: 'TW' | 'CN';
  source: 'holding' | 'manual' | 'watchlist' | 'scan';
  isHolding: boolean;
  /** 只有 source='holding' 才帶（guard 規則1 停損判斷用） */
  holding?: MonitoredHoldingInfo;
}

export async function getActiveSymbols(): Promise<MonitoredSymbol[]> {
  const out: MonitoredSymbol[] = [];
  const seen = new Set<string>();

  const holdings = await readHoldings();
  for (const h of holdings) {
    if (seen.has(h.symbol)) continue;
    out.push({ symbol: h.symbol, market: h.market, source: 'holding', isHolding: true, holding: h.holding });
    seen.add(h.symbol);
  }

  const extras = await readExtraSymbols();
  for (const x of extras) {
    if (seen.has(x.symbol)) continue;
    if (out.length >= REALTIME_RULES.POOL_HARD_CAP) break;
    out.push({ symbol: x.symbol, market: x.market, source: 'manual', isHolding: x.isHolding });
    seen.add(x.symbol);
  }

  for (const market of ['TW', 'CN'] as const) {
    if (out.length >= REALTIME_RULES.POOL_HARD_CAP) break;
    const candidates = await readPoolCandidates(market);
    for (const c of candidates) {
      if (out.length >= REALTIME_RULES.POOL_HARD_CAP) break;
      if (seen.has(c.symbol)) continue;
      out.push({
        symbol: c.symbol, market,
        source: 'scan', isHolding: false,
      });
      seen.add(c.symbol);
    }
  }

  return out;
}

// ── readers ──────────────────────────────────────────────────────────────

interface RawHolding {
  symbol: string;
  market?: 'TW' | 'CN';
  status?: string;
  name?: string;
  entryPrice?: number;
  stopLoss?: number;
  ui?: Record<string, unknown>;
}

async function readHoldings(): Promise<Array<{ symbol: string; market: 'TW' | 'CN'; holding?: MonitoredHoldingInfo }>> {
  const result: Array<{ symbol: string; market: 'TW' | 'CN'; holding?: MonitoredHoldingInfo }> = [];
  // TW：data/agents/portfolio/holdings.json（業務邏輯 legacy 路徑）
  await pushHoldings(path.join(process.cwd(), 'data', 'agents', 'portfolio', 'holdings.json'), result);
  // CN：data/portfolio/holdings-cn.json（鐵則：陸股持倉不放 agents/portfolio）。
  //     F5 修正：原本沒讀 CN 持倉 → realtime 漏盯現持陸股、只能靠 stale 的 extra-symbols.json。
  await pushHoldings(path.join(process.cwd(), 'data', 'portfolio', 'holdings-cn.json'), result);
  return result;
}

async function pushHoldings(
  p: string,
  out: Array<{ symbol: string; market: 'TW' | 'CN'; holding?: MonitoredHoldingInfo }>,
): Promise<void> {
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as { holdings?: RawHolding[] };
    for (const h of parsed.holdings ?? []) {
      if (!h.symbol || h.status === 'closed') continue;
      // 場外基金（.OF）無盤中 K 線，且 6 位裸碼與 A 股撞號（000001 基金 vs 平安銀行）
      // → 入池會拿錯標的的 quote 發保命警報，一律排除
      if (/\.OF$/i.test(h.symbol)) continue;
      out.push({
        symbol: h.symbol,
        market: h.market ?? inferMarketFromSymbol(h.symbol),
        holding: toHoldingInfo(h),
      });
    }
  } catch { /* 檔案不存在 / parse 失敗 → skip */ }
}

/** 派生做空語意 — 逐字對齊 daily-action route（ui.positionSide / ui.entryKbar.high） */
function toHoldingInfo(h: RawHolding): MonitoredHoldingInfo | undefined {
  if (typeof h.entryPrice !== 'number' || h.entryPrice <= 0) return undefined;
  const positionSide: 'long' | 'short' = h.ui?.positionSide === 'short' ? 'short' : 'long';
  const entryKbar = h.ui?.entryKbar as { high?: number } | undefined;
  const entryHigh = typeof entryKbar?.high === 'number' ? entryKbar.high : undefined;
  return {
    name: h.name ?? h.symbol,
    entryPrice: h.entryPrice,
    stopLoss: typeof h.stopLoss === 'number' && h.stopLoss > 0 ? h.stopLoss : undefined,
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

async function readExtraSymbols(): Promise<Array<{ symbol: string; market: 'TW' | 'CN'; isHolding: boolean }>> {
  try {
    const p = path.join(process.cwd(), 'data', 'realtime', 'extra-symbols.json');
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as { symbols?: RawExtraSymbol[] };
    return (parsed.symbols ?? [])
      .filter(s => s.symbol && (s.market === 'TW' || s.market === 'CN'))
      .map(s => ({ symbol: s.symbol, market: s.market, isHolding: s.isHolding ?? false }));
  } catch {
    return [];
  }
}

async function readPoolCandidates(market: 'TW' | 'CN'): Promise<Array<{ symbol: string }>> {
  try {
    const today = todayInMarket(market);
    const p = path.join(process.cwd(), 'data', 'agents', 'pool', market, `${today}.json`);
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) return [];
    const age = Date.now() - stat.mtimeMs;
    if (age > REALTIME_RULES.SCAN_CANDIDATE_TTL_MS) return [];
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as { candidates?: Array<{ symbol: string }> };
    return (parsed.candidates ?? []).filter(c => c.symbol);
  } catch {
    return [];
  }
}

function inferMarketFromSymbol(symbol: string): 'TW' | 'CN' {
  if (/\.(TW|TWO)$/i.test(symbol)) return 'TW';
  if (/\.(SS|SZ)$/i.test(symbol)) return 'CN';
  return 'TW';
}

function todayInMarket(market: 'TW' | 'CN'): string {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}
