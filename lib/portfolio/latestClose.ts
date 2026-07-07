/**
 * loadLatestClose — 讀某檔最新封存日K收盤價（持倉估值共用單一事實）。
 *
 * TW 上市/上櫃後綴容錯：持股若把上櫃股存成 .TW（或反之），而 candle 檔是另一個
 * 後綴（如 3081 聯亞 持股存 3081.TW、K 檔卻是 3081.TWO），舊版逐檔讀取會直接
 * 讀不到 → 該檔市值算成 0 → 總資產短少（曾把 54.5M 算成 16.4M，漏掉聯亞 38M）。
 * 這裡先試持股後綴，找不到再試另一個 TW 後綴。
 *
 * 供 growth-status / size-suggestion / swap-suggestion 共用，避免各自 fork 出漏算。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { MarketId } from '@/lib/scanner/types';

const CANDLES_ROOT = path.join(process.cwd(), 'data', 'candles');

async function readLastClose(symbol: string, market: MarketId): Promise<number | null> {
  const p = path.join(CANDLES_ROOT, market, `${symbol}.json`);
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const data = JSON.parse(raw) as { candles?: Array<{ close: number }> };
    const c = data.candles ?? [];
    return c.length > 0 ? c[c.length - 1].close : null;
  } catch {
    return null;
  }
}

export async function loadLatestClose(symbol: string, market: MarketId): Promise<number | null> {
  const direct = await readLastClose(symbol, market);
  if (direct != null) return direct;
  // TW 後綴容錯：.TW ↔ .TWO
  if (market === 'TW') {
    const m = symbol.match(/^(.+)\.(TW|TWO)$/i);
    if (m) {
      const alt = `${m[1]}.${m[2].toUpperCase() === 'TW' ? 'TWO' : 'TW'}`;
      return readLastClose(alt, market);
    }
  }
  return null;
}
