/**
 * 主力券商分點 L1 儲存層（per-stock）
 *
 * 路徑：data/chips/TW/broker/{code}.json
 *
 * Yahoo broker-trading 只有「當日」快照 → 靠 cron 每日 append 累積歷史時序，
 * 之後 lib/chipcost/brokerCost.ts 才能算「主力成本均線」。
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { BrokerDay } from './types';

const BROKER_DIR = path.join(process.cwd(), 'data', 'chips', 'TW', 'broker');

export interface BrokerStockFile {
  symbol: string;
  market: 'TW';
  lastDate: string;
  updatedAt: string;
  data: Array<{ date: string } & BrokerDay>;  // 升冪 by date
}

export async function readBrokerStock(code: string): Promise<BrokerStockFile | null> {
  try {
    const raw = await fs.readFile(path.join(BROKER_DIR, `${code}.json`), 'utf8');
    return JSON.parse(raw) as BrokerStockFile;
  } catch {
    return null;
  }
}

/** Merge 一日主力分點到 per-stock 檔（去重 by date，後者覆蓋）。 */
export async function appendBrokerDay(code: string, date: string, row: BrokerDay): Promise<void> {
  await fs.mkdir(BROKER_DIR, { recursive: true });
  const existing = await readBrokerStock(code);
  const map = new Map<string, { date: string } & BrokerDay>();
  for (const r of existing?.data ?? []) map.set(r.date, r);
  map.set(date, { date, ...row });
  const merged = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  const file: BrokerStockFile = {
    symbol: code,
    market: 'TW',
    lastDate: merged[merged.length - 1]?.date ?? '',
    updatedAt: new Date().toISOString(),
    data: merged,
  };
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  await atomicFsPut(path.join(BROKER_DIR, `${code}.json`), JSON.stringify(file));
}
