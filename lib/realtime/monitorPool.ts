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

export interface MonitoredSymbol {
  symbol: string;        // 帶 suffix：3661.TW / 603986.SS
  market: 'TW' | 'CN';
  source: 'holding' | 'manual' | 'watchlist' | 'scan';
  isHolding: boolean;
}

export async function getActiveSymbols(): Promise<MonitoredSymbol[]> {
  const out: MonitoredSymbol[] = [];
  const seen = new Set<string>();

  const holdings = await readHoldings();
  for (const h of holdings) {
    if (seen.has(h.symbol)) continue;
    out.push({ symbol: h.symbol, market: h.market, source: 'holding', isHolding: true });
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
}

async function readHoldings(): Promise<Array<{ symbol: string; market: 'TW' | 'CN' }>> {
  try {
    const p = path.join(process.cwd(), 'data', 'agents', 'portfolio', 'holdings.json');
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as { holdings?: RawHolding[] };
    const result: Array<{ symbol: string; market: 'TW' | 'CN' }> = [];
    for (const h of parsed.holdings ?? []) {
      if (!h.symbol || h.status === 'closed') continue;
      const market = h.market ?? inferMarketFromSymbol(h.symbol);
      result.push({ symbol: h.symbol, market });
    }
    return result;
  } catch {
    return [];
  }
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
