import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { DilutionEvent } from './types';

/**
 * 公司行動資料的單一讀取入口。
 *
 * `newShares=0` 代表公告已存在、但最終發行股數尚未確定；這種事件仍必須送進
 * 估值流程，不能因為暫時無法量化就被誤顯示成「沒有稀釋」。
 */
export async function readDilutionEvents(symbol: string): Promise<DilutionEvent[]> {
  const ticker = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const filePath = path.join(process.cwd(), 'data', 'dilution', `${ticker}.json`);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is DilutionEvent => {
      if (!entry || typeof entry !== 'object') return false;
      const item = entry as Partial<DilutionEvent>;
      return typeof item.type === 'string'
        && typeof item.newShares === 'number'
        && Number.isFinite(item.newShares)
        && item.newShares >= 0;
    });
  } catch {
    return [];
  }
}

/** 穩定序列化，用來判斷估值後是否出現新的增資／GDR／私募／CB 事件。 */
export function dilutionEventSignature(events: DilutionEvent[]): string {
  return events
    .map(event => [
      event.type,
      event.status ?? '',
      event.newShares,
      event.expectedDate ?? '',
      event.announcedAt ?? '',
      event.sourceUrl ?? '',
    ].join('|'))
    .sort()
    .join('||');
}
